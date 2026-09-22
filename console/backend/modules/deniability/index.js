const routes = require('./routes');

module.exports = {
  register(core) {
    core.logger.info('Registering Deniability module routes');

    // Mount under /api/auth
    core.routes.mount('/api/auth', routes);
  }
};
