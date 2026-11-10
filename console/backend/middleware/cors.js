const cors = require('cors');
const config = require('../config/env');

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * Whether a browser origin may read responses with credentials.
 *
 * Only the configured origins, plus localhost outside production. This used to answer
 * yes to every origin, so any page -- another site under the same registrable domain
 * with a script of its own, for one -- could read authenticated responses of the legacy
 * cookie session (security review, 10 November 2026, M1). A request with no Origin
 * header is not a browser cross-origin request (curl, the Go nodes, same-origin GETs)
 * and is not CORS's to judge.
 */
function originAllowed(origin, { production = config.IS_PRODUCTION } = {}) {
  if (!origin) return true;
  if (config.CORS_ORIGINS.includes(origin) || config.CORS_ORIGINS.includes('*')) return true;
  return !production && LOCAL_ORIGIN.test(origin);
}

const corsOptions = {
  origin: function (origin, callback) {
    // false, not an error: the request is still answered, without the headers that
    // would let a foreign page read the answer.
    callback(null, originAllowed(origin));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  credentials: true
};

module.exports = cors(corsOptions);
module.exports.originAllowed = originAllowed;
