const express = require('express');
const router = express.Router();
const PrometheusService = require('../services/PrometheusService');

router.get('/', async (req, res) => {
  try {
    const output = await PrometheusService.renderMetrics();
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.status(200).send(output);
  } catch (err) {
    res
      .status(500)
      .setHeader('Content-Type', 'text/plain; charset=utf-8')
      .send(`# Error generating metrics: ${err.message}\n`);
  }
});

module.exports = router;
