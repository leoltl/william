const REDIRECT_RESOURCE_URI_CODE = 302;

const defaultConfig = {
  getKeyFromRequest: (req) => req.get("X-Idempotency-Key"),
  generateIdempotentPayload: (body, statusCode) => ({
    body,
    statusCode,
  }),
  generateErrorPayload: (error) => ({
    statusCode: 500,
    body: `Internal Server Error${error?.message ? ` - ${error.message}` : ""}`,
  }),
};

module.exports = function configureIdempotentMiddleware({ store }) {
  return function makeIdempotencyMiddleware(routeHandler, _config = {}) {
    const config = Object.assign({}, defaultConfig, _config);

    return [
      async function (req, res, next) {
        req.idempotency_key = config.getKeyFromRequest.apply(this, [req]);

        if (!req.idempotency_key) {
          // TODO: warn and error
          return;
        }

        const storedIdempotentRequest = await store.retrieve(
          req.idempotency_key
        );

        const seenIdempotentRequest =
          storedIdempotentRequest &&
          IdempotentRequest.deserialize(storedIdempotentRequest);

        if (seenIdempotentRequest && seenIdempotentRequest.isInflight()) {
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

            throw error;
          }
        }

        await store.create(
          new IdempotentRequest(req.idempotency_key, req.path)
        );

        res.expressSend = res.send;

        // overriding it to extract response body
        res.send = function (body) {
          res.locals.intercepted_response = body;
          next();
        };

        try {
          return await routeHandler.apply(this, [req, res, next]);
        } catch (error) {
          next(error);
        }
      },
      async function successRequestHandler(req, res) {
        // send the response to client and storing idempotent request while it is streaming
        res.expressSend(res.locals.intercepted_response);

        const idempotentPayload = config.generateIdempotentPayload?.apply(
          this,
          [res.locals.intercepted_response, res.statusCode]
        );

        const idempotentRequest = IdempotentRequest.deserialize(
          await store.retrieve(req.idempotency_key)
        );

        idempotentRequest.complete(idempotentPayload);

        await store.update(idempotentRequest);
      },
      // we need 4 params so express know to pass error to this handler and store the idempotent
      // error result here for an idempotent endpoint
      async function errorRequestHandler(error, req, res, next) {
        if (arguments.length === 4) {
          const idempotentErrorPayload = config.generateErrorPayload?.apply(
            this,
            [error]
          );
          const idempotentRequest = IdempotentRequest.deserialize(
            await store.retrieve(req.idempotency_key)
          );

          idempotentRequest.setErrored(idempotentErrorPayload);

          await store.update(idempotentRequest);

          res
            .status(idempotentErrorPayload.statusCode)
            .expressSend(idempotentErrorPayload.body);
        } else {
          res(); // this is next() if arguments.length == 3
        }
      },
    ];
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
  constructor(id, request_uri, status = "started", payload = null) {
    this.id = id;
    this.request_uri = request_uri;
    this.status = status;
    this.payload = JSON.parse(payload);
  }

  serialize() {
    return {
      id: this.id,
      status: this.status,
      request_uri: this.request_uri,
      payload: JSON.stringify(this.payload ?? null),
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

    if (request.path !== this.request_uri) {
      return false;
    }

    return true;
  }

  static deserialize(serializedRequest) {
    return new IdempotentRequest(
      serializedRequest.id,
      serializedRequest.request_uri,
      serializedRequest.status,
      serializedRequest.payload
    );
  }
}

module.exports.REDIRECT_RESOURCE_URI_CODE = REDIRECT_RESOURCE_URI_CODE;
