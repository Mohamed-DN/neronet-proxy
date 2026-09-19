/**
 * Warrant canary, served from the root of the origin.
 *
 * These three handlers used to live in the nuke router, and serving them from the
 * root was the reason server.js mounted that whole router at '/' as well as at
 * '/api/nuke'. Every self-destruct and dead man's switch route was therefore
 * reachable outside /api, where the API rate limiter is applied -- so
 * POST /personal-dms/unlock existed alongside /api/nuke/personal-dms/unlock and was
 * metered by nothing.
 *
 * A warrant canary has to be fetchable without a credential and at a predictable
 * address, which is what /.well-known/canary.txt is for. That requirement belongs
 * to these three routes and to nothing else in the nuke router.
 */

const express = require('express');
const CanaryService = require('../services/CanaryService');

const router = express.Router();

async function handleCanaryRequest(req, res, next) {
  try {
    const canary = await CanaryService.getLatestCanary();

    if (req.headers.accept === 'text/plain' && !req.headers.accept.includes('json')) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send(canary.raw);
    }

    return res.status(200).json({
      valid: Boolean(canary.valid),
      raw: canary.raw,
      statement_text: canary.statement_text,
      signature: canary.ed25519_signature,
      signer_public_key: canary.signer_public_key,
      published_at: canary.published_at,
      is_active: canary.is_active
    });
  } catch (err) {
    next(err);
  }
}

router.get('/canary', handleCanaryRequest);
router.get('/canary.txt', handleCanaryRequest);
router.get('/.well-known/canary.txt', handleCanaryRequest);

module.exports = router;
