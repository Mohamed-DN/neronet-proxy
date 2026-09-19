const config = require('../config/env');
const { notFoundHandler } = require('./errorHandler');

/**
 * Answer 404 for every path under a router whose feature is switched off.
 *
 * The response is the same one an unrouted path gets, so a disabled feature cannot
 * be told apart from one that never existed. That includes routes that are public
 * by design, such as the Cloud PC custom-domain gateway, which sits behind this
 * check like everything else.
 */
function requireFeature(name) {
  return function featureGate(req, res, next) {
    if (config.features()[name] === true) {
      return next();
    }
    return notFoundHandler(req, res, next);
  };
}

module.exports = { requireFeature };
