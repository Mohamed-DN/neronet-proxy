const express = require('express');
const Browser = require('../services/BrowserContextService');
const { isCookieSecure } = require('../utils/cookies');
const { rateLimit } = require('../middleware/rateLimit');
const logger = require('../utils/logger');

// Families that can never be selected again are revoked after the context commit,
// in account -> family order. A failure leaves them to expire; it never fails the request.
async function closeFamilies(families) {
  try {
    await Browser.closeFamilies(families);
  } catch (error) {
    logger.error(`Closing retired browser session families failed: ${error.message}`);
  }
}
const router = express.Router();
const creationLimiter = rateLimit({
  name: 'browser-context-create',
  limit: 10,
  windowMs: 60 * 60_000,
  keyFn: (req) => req.ip || req.socket?.remoteAddress || null
});

router.post(
  '/context',
  (req, res, next) => {
    try {
      req.browserContextProof = Browser.proofFromRequest(req, req.body?.context_id);
      // A supplied binding selects the existing-context read path, which can never
      // insert a context. Forging a cookie therefore cannot bypass creation limits.
      if (req.browserContextProof.binding) return next();
      return creationLimiter(req, res, next);
    } catch (error) {
      return next(error);
    }
  },
  async (req, res, next) => {
    try {
      const proof = req.browserContextProof;
      const result = proof.binding ? await Browser.readBoundContext(proof) : await Browser.bootstrap(proof);
      if (result.binding) {
        res.cookie(Browser.bindingCookieName(proof.id), result.binding, {
          httpOnly: true,
          secure: isCookieSecure(req),
          sameSite: 'Strict',
          path: '/',
          maxAge: 30 * 24 * 60 * 60 * 1000
        });
      }
      res.set('Cache-Control', 'no-store');
      return res.json(result.context);
    } catch (error) {
      next(error);
    }
  }
);

router.post('/intent', async (req, res, next) => {
  try {
    const proof = Browser.proofFromRequest(req);
    const { operation, families } = await Browser.admitIntent(proof, req.body);
    await closeFamilies(families);
    res.set('Cache-Control', 'no-store');
    return res.json(operation);
  } catch (error) {
    next(error);
  }
});

// Compare-and-set adoption of a login candidate. Selecting changes no credential:
// the candidate's cookies already exist; selection decides whether they count.
router.post('/select', async (req, res, next) => {
  try {
    const proof = Browser.proofFromRequest(req);
    const { families, ...result } = await Browser.selectCandidate(proof, req.body);
    await closeFamilies(families);
    res.set('Cache-Control', 'no-store');
    return res.json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
