const { InMemoryStore } = require("./store");

const REDIRECT_RESOURCE_URI_CODE = 302;

const defaultConfig = {
  getKeyFromRequest: (req) => req.get("X-Idempotency-Key"),
  generateIdempotentResult: (body, statusCode) => ({
    body,
    statusCode,
  }),
  generateIdempotentErrorResult: (error) => ({
    statusCode: 500,
    body: `Internal Server Error${error?.message ? ` - ${error.message}` : ""}`,
  }),
};

module.exports = function initialize({ store = new InMemoryStore() } = {}) {
  return {
    useIdempotency: function makeIdempotencyMiddleware(config = {}) {
      const routeConfig = Object.assign({}, defaultConfig, config);

      return async function (req, res, next) {
        req.idempotency_key = routeConfig.getKeyFromRequest(req);

        if (!req.idempotency_key) {
          return res
            .status(400)
            .send("Idempotency key is required on an idempotent endpoint");
        }

        const storedIdempotentRequest = await store.retrieve(
          req.idempotency_key
        );

        const seenIdempotentRequest =
          storedIdempotentRequest &&
          IdempotentRequest.deserialize(storedIdempotentRequest);

        if (
          seenIdempotentRequest &&
          seenIdempotentRequest.isInflight() &&
          !seenIdempotentRequest.isMultiPhase()
        ) {
          return res
            .status(409)
            .send("Another request with same idempotency key is in flight");
        }

        if (seenIdempotentRequest && seenIdempotentRequest.isTerminal()) {
          try {
            return await runIdempotentRequest(req, res, seenIdempotentRequest);
          } catch (error) {
            if (error.message === "Request intent has changed") {
              return res.status(400).send(error.message);
            }

            return next(error);
          }
        }

        let idempotencyRequest;

        if (seenIdempotentRequest && seenIdempotentRequest.isMultiPhase()) {
          idempotencyRequest = seenIdempotentRequest;
        } else {
          idempotencyRequest = new IdempotentRequest(
            req.idempotency_key,
            req.path
          );

          await store.create(idempotencyRequest);
        }

        req.idempotency ??= {};
        req.idempotency.executeMultiPhase = async function (phases) {
          let prevPhaseResult = null;

          let _phases = [...phases];

          if (idempotencyRequest.isMultiPhase()) {
            _phases = idempotencyRequest.getIncompletePhases(phases);
            prevPhaseResult = idempotencyRequest.multiPhase.previousPhaseResult;
          }

          for (const phase of _phases) {
            const name = phase.name;
            const work = phase.work;
            try {
              prevPhaseResult = await work(req, prevPhaseResult);
              idempotencyRequest.setRecoveryPoint(name, prevPhaseResult);
              await store.update(idempotencyRequest);
            } catch (error) {
              next(error);
            }
          }

          return prevPhaseResult;
        };

        res._idempotency = { config: routeConfig };
        res.expressSend = res.send;

        // overriding it to extract response body
        res.send = function (body) {
          res._idempotency.intercepted_response = body;
          next();
        };

        next();
      };
    },
    idempotency: function () {
      return [
        async function successRequestHandler(req, res, next) {
          if (!res._idempotency) {
            return next();
          }

          const idempotentRequest = IdempotentRequest.deserialize(
            await store.retrieve(req.idempotency_key)
          );

          // send the response to client and storing idempotent request while it is streaming
          res.expressSend(res.idempotency.intercepted_response);

          const idempotentResult =
            res.idempotency.config.generateIdempotentResult?.(
              idempotentRequest.isMultiPhase()
                ? JSON.stringify(
                    idempotentRequest.multiPhase.previousPhaseResult
                  )
                : res.idempotency.intercepted_response,
              res.statusCode
            );

          idempotentRequest.complete(idempotentResult);

          await store.update(idempotentRequest);
        },
        // we need 4 params so express know to pass error to this handler and store the idempotent
        // error result here for an idempotent endpoint
        async function errorRequestHandler(error, req, res, next) {
          if (!res._idempotency) {
            return next(error);
          }

          const idempotentRequest = IdempotentRequest.deserialize(
            await store.retrieve(req.idempotency_key)
          );

          if (
            idempotentRequest.isMultiPhase() &&
            !idempotentRequest.isTerminal()
          ) {
            return next(error);
          }

          const idempotentErrorResult =
            res._idempotency.config.generateIdempotentErrorResult?.(error);

          idempotentRequest.setErrored(idempotentErrorResult);

          await store.update(idempotentRequest);

          res
            .status(idempotentErrorResult.statusCode)
            .expressSend(idempotentErrorResult.body);
        },
      ];
    },
  };
};

async function runIdempotentRequest(req, res, seenIdempotentRequest) {
  if (!seenIdempotentRequest.shouldReRun(req)) {
    throw new Error("Request intent has changed");
  }

  const { status_code, body, redirect_uri } = seenIdempotentRequest.rerun();

  if (redirect_uri) {
    // redirect to re-fetch the latest state of a resource
    return res.redirect(REDIRECT_RESOURCE_URI_CODE, redirect_uri);
  }

  if (status_code) {
    res.status(status_code);
  }

  res.send(body);
}

class IdempotentRequest {
  constructor(
    id,
    request_path,
    status = "started",
    payload = null,
    multiPhase = null
  ) {
    this.id = id;
    this.request_path = request_path;
    this.status = status;
    this.payload = JSON.parse(payload);
    this.multiPhase = JSON.parse(multiPhase);
  }

  serialize() {
    return {
      id: this.id,
      status: this.status,
      request_path: this.request_path,
      payload: JSON.stringify(this.payload ?? null),
      multiPhase: JSON.stringify(this.multiPhase ?? null),
    };
  }

  complete(payload) {
    this.status = "completed";
    this.payload = {
      statusCode: payload.statusCode,
      body: payload.body,
      redirect_uri: payload.redirect_uri,
    };
  }

  setErrored(payload) {
    this.status = "errored";
    this.payload = {
      statusCode: payload.statusCode,
      body: payload.body,
    };
  }

  isInflight() {
    return this.status === "started";
  }

  isTerminal() {
    return !this.isInflight();
  }

  rerun() {
    if (this.isTerminal()) {
      return {
        status_code: this.payload.statusCode,
        body: this.payload.body,
        redirect_uri: this.payload.redirect_uri,
      };
    }
  }

  shouldReRun(request) {
    if (!this.isTerminal()) {
      return false;
    }

    if (request.path !== this.request_path) {
      return false;
    }

    return true;
  }

  isMultiPhase() {
    return !!this.multiPhase;
  }

  setRecoveryPoint(recovery_point, previousPhaseResult) {
    this.multiPhase = {
      recovery_point,
      previousPhaseResult,
    };
  }

  getIncompletePhases(phases) {
    const _phases = [...phases];
    const idx =
      phases.findIndex(
        (p) => p.recovery_point === this.multiPhase.recovery_point
      ) ?? 0;
    return _phases.slice(idx);
  }

  static deserialize(serializedRequest) {
    return new IdempotentRequest(
      serializedRequest.id,
      serializedRequest.request_path,
      serializedRequest.status,
      serializedRequest.payload,
      serializedRequest.multiPhase
    );
  }
}

module.exports.REDIRECT_RESOURCE_URI_CODE = REDIRECT_RESOURCE_URI_CODE;
