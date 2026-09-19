/**
 * Bounded list responses.
 *
 * Every list endpoint ran an unbounded `SELECT *`. Measured on the running system a
 * node row serialises to about 805 bytes, so a fleet of 100,000 nodes answers a
 * single dashboard request with roughly 77 MB -- read from the database, held in the
 * Node heap, serialised to JSON on the one thread that also serves every other
 * request, and then handed to a browser that feeds it into a 3D force simulation.
 *
 * A default page size is not a nicety here. It is the difference between a system
 * that degrades and one that stops.
 */

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * Read pagination parameters from a request.
 *
 * Out-of-range values are clamped rather than rejected: a client asking for more
 * than the maximum wants as much as it can get, and failing the request teaches it
 * nothing a clamp does not.
 */
function readPageParams(req, { defaultLimit = DEFAULT_LIMIT, maxLimit = MAX_LIMIT } = {}) {
  const rawLimit = Number.parseInt(req.query.limit, 10);
  const rawOffset = Number.parseInt(req.query.offset, 10);

  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), maxLimit) : defaultLimit;

  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;

  return { limit, offset };
}

/**
 * Build the envelope for a paginated response.
 *
 * `total` is the size of the whole matching set, not of this page, so a client can
 * tell the difference between "that is everything" and "there is more". Leaving it
 * out is how a UI ends up silently showing the first hundred of ten thousand.
 */
function pageEnvelope({ items, total, limit, offset }) {
  return {
    total,
    count: items.length,
    limit,
    offset,
    has_more: offset + items.length < total
  };
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  readPageParams,
  pageEnvelope
};
