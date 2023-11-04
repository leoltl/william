class IIdempotencyStore {
  async create(idempotentRequest) {}

  async retrieve(requestId) {}

  async update(idempotentRequest) {}
}

module.exports.IIdempotencyStore = IIdempotencyStore;

class InMemoryIdempotencyStore extends IIdempotencyStore {
  #store = {};

  async create(idempotentRequest) {
    this.#store[idempotentRequest.id] = idempotentRequest.serialize();
  }

  async retrieve(requestId) {
    return this.#store[requestId];
  }

  async update(idempotentRequest) {
    this.#store[idempotentRequest.id] = idempotentRequest.serialize();
  }
}

module.exports.InMemoryStore = InMemoryIdempotencyStore;
