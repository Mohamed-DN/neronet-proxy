const routes = require('./routes');
const CircuitEngine = require('./CircuitEngine');

module.exports = {
  register(core) {
    core.logger.info('Registering Onion Routing module routes');

    // Mount module routes under /v4/control
    core.routes.mount('/v4/control', routes);
  },

  CircuitEngine
};
