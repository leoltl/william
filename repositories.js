const userRepository = {
  _store: {},
  create: async (u) => {
    userRepository._store[u.id] = u;
    return u;
  },
  retrieve: async (uId) => {
    return userRepository._store[uId];
  },
};

module.exports.userRepository = userRepository;

const emailOutboxRepository = {
  _store: {},
  _id: 0,
  create: async (email) => {
    emailOutboxRepository._store[emailOutboxRepository._id] = email;
    emailOutboxRepository._id++;
    return email;
  },
  retrieve: async (outboxId) => {
    return emailOutboxRepository._store[outboxId];
  },
};

module.exports.emailOutboxRepository = emailOutboxRepository;
