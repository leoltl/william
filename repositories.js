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
