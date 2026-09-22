const PrometheusService = require('../services/PrometheusService');

function requestMetrics(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    const method = req.method;
    const status = String(res.statusCode);
    PrometheusService.recordHttpRequest(method, status, duration);
  });

  next();
}

module.exports = requestMetrics;
