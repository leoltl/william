const configureMiddleware = require("./middleware");

const { InMemoryStore } = require("./store");

module.exports = configureMiddleware({
  store: new InMemoryStore(),
});
