const app = require("express")();

const idempotency = require("./idempotency")();
const { userRepository, emailOutboxRepository } = require("./repositories");

let counter = 0;

app.post(
  "/user",
  idempotency.useIdempotency({
    generateIdempotentResult: (userJson, statusCode) => {
      return { body: userJson, statusCode };
    },
    generateIdempotentErrorResult: (error) => {
      if (error.message === "User cannot be created") {
        return {
          statusCode: 409,
          body: "User is duplicated",
        };
      }
      return {
        statusCode: 500,
        body: "Internal Server Error",
      };
    },
  }),
  async (req, res, next) => {
    try {
      const user = await userRepository.create({ id: counter });

      if (counter === 2) {
        counter++;
        // simulate an error
        throw new Error("User cannot be created");
      }

      counter++;

      res.json(user);
    } catch (err) {
      next(err);
    }
  }
);

app.get("/user/:id", async (req, res) => {
  console.log("get latest state for a user", req.params.id);

  res.send(await userRepository.retrieve(req.params.id));
});

app.post(
  "/v2/user",
  idempotency.useIdempotency({
    generateIdempotentResult: (userJson) => {
      const parsed = JSON.parse(userJson);
      return {
        redirect_uri: `http://localhost:3000/user/${parsed.id}`,
      };
    },
  }),
  async (req, res) => {
    const user = await userRepository.create({ id: counter });
    counter++;
    res.json(user);
  }
);

app.post("/v3/user", idempotency.useIdempotency(), async (req, res) => {
  const finalResult = await req.idempotency.executeMultiPhase([
    {
      name: "phase_one",
      work: async (req, prevPhaseResult) => {
        const user = await userRepository.create({ id: counter });
        return user;
      },
    },
    {
      name: "phase_two",
      work: async (req, prevPhaseResult) => {
        await emailOutboxRepository.create({
          type: "user_activation",
          id: prevPhaseResult.id,
        });

        return prevPhaseResult;
      },
    },
  ]);

  res.json(finalResult);
});

app.use("*", idempotency.idempotency());

app.listen(3000, () => {
  console.log("server listing on port 3000");
});
