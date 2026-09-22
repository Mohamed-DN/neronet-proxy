const routes = require('./routes');
const NukeEngine = require('./NukeEngine');

module.exports = {
  register(core) {
    core.logger.info('Registering NeroNuke module routes and scheduler');

    // Mount module routes at /api/nuke
    core.routes.mount('/api/nuke', routes);

    // Schedule dead man's switch and scheduled destruction checks every 60s
    core.scheduler.every(60000, async () => {
      try {
        await NukeEngine.checkExpiredDeadManSwitches();
      } catch (err) {
        core.logger.error(`Error in DMS background check: ${err.message}`);
      }
    });
  },

  NukeEngine
};
