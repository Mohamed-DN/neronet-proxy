const logger = require('../utils/logger');

function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  const message = err.message || 'Internal Server Error';
  // The detail of a server error stays in the log: it can name tables, constraints or paths.
  // A client error carries a message written for the client.
  const clientMessage = status >= 500 ? 'Internal Server Error' : message;

  logger.error(`[${req.method}] ${req.originalUrl || req.path} -> ${status}: ${message}`);
  if (err.stack && (process.env.NODE_ENV === 'development' || process.env.DEBUG)) {
    logger.error(err.stack);
  }

  res.status(status).json({
    error: clientMessage,
    // A machine-readable reason only on deliberate client errors, never on a 5xx.
    ...(status < 500 && typeof err.code === 'string' && /^[a-z_]+$/.test(err.code) ? { code: err.code } : {}),
    ...(process.env.NODE_ENV === 'development' ? { stack: err.stack } : {})
  });
}

function notFoundHandler(req, res, next) {
  res.status(404).json({
    error: `Endpoint '${req.originalUrl || req.path}' not found`
  });
}

module.exports = {
  errorHandler,
  notFoundHandler
};
