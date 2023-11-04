const app = require("express")();

const makeIdempotentEndpoint = require("./idempotency");
const { userRepository } = require("./repositories");

let counter = 0;

app.post(
  "/user",
  makeIdempotentEndpoint(
    async (req, res) => {
      const user = await userRepository.create({ id: counter });

      if (counter === 2) {
        counter++;
        // simulate an error
        throw new Error("User cannot be created");
      }

      counter++;

      res.json(user);
    },
    {
      generateIdempotentPayload: (userJson, statusCode) => {
        return { body: userJson, statusCode };
      },
      generateErrorPayload: (error) => {
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
    }
  )
);

app.get("/user/:id", async (req, res) => {
  console.log("get latest state for a user", req.params.id);

  res.send(await userRepository.retrieve(req.params.id));
});

app.post(
  "/v2/user",
  makeIdempotentEndpoint(
    async (req, res) => {
      const user = await userRepository.create({ id: counter });
      counter++;
      res.json(user);
    },
    {
      generateIdempotentPayload: (userJson) => {
        const parsed = JSON.parse(userJson);
        return {
          redirect_uri: `http://localhost:3000/user/${parsed.id}`,
        };
      },
    }
  )
);

app.listen(3000, () => {
  console.log("server listing on port 3000");
});
