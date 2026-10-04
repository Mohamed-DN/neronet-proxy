const jwt = require('jsonwebtoken');
const config = require('../../config/env');

/**
 * A two-organisation fixture with a hidden (Ghost Vault) compartment, for the tests
 * that check what a session below the root tier can learn about it.
 *
 * Organisation A has a visible node pair (v1, v2), one node inside a hidden
 * compartment (h1) and a visible Lab compartment. Organisation B has one node (b1).
 * Everyone is created directly in the database; the tokens are signed with the
 * server's own secret and carry the tier they were issued for.
 */

const ORG_A = 'org-sec-a';
const ORG_B = 'org-sec-b';
const DEFAULT_COMPARTMENT = `cmp-${ORG_A}`;
const HIDDEN_COMPARTMENT = 'cmp-sec-hidden';
const LAB_COMPARTMENT = 'cmp-sec-lab';

const NODES = {
  v1: { id: 'node-sec-v1', vip: '100.64.77.1', user: 'usr-sec-netadmin', org: ORG_A, compartment: null },
  v2: { id: 'node-sec-v2', vip: '100.64.77.2', user: 'usr-sec-member', org: ORG_A, compartment: null },
  h1: { id: 'node-sec-h1', vip: '100.64.77.9', user: 'usr-sec-owner', org: ORG_A, compartment: HIDDEN_COMPARTMENT },
  b1: { id: 'node-sec-b1', vip: '100.64.78.1', user: 'usr-sec-owner-b', org: ORG_B, compartment: null }
};

const USERS = {
  owner: { id: 'usr-sec-owner', org: ORG_A, orgRole: 'owner', tier: 'standard' },
  rootOwner: { id: 'usr-sec-owner', org: ORG_A, orgRole: 'owner', tier: 'root' },
  // A platform role of 'admin' is what the ACL administration routes check.
  admin: { id: 'usr-sec-admin', org: ORG_A, orgRole: 'admin', tier: 'standard', platformRole: 'admin' },
  rootAdmin: { id: 'usr-sec-admin', org: ORG_A, orgRole: 'admin', tier: 'root', platformRole: 'admin' },
  netadmin: { id: 'usr-sec-netadmin', org: ORG_A, orgRole: 'network_admin', tier: 'standard' },
  rootNetadmin: { id: 'usr-sec-netadmin', org: ORG_A, orgRole: 'network_admin', tier: 'root' },
  member: { id: 'usr-sec-member', org: ORG_A, orgRole: 'member', tier: 'standard' },
  auditor: { id: 'usr-sec-auditor', org: ORG_A, orgRole: 'auditor', tier: 'standard' },
  ownerB: { id: 'usr-sec-owner-b', org: ORG_B, orgRole: 'owner', tier: 'standard' },
  superAdmin: { id: 'usr-sec-super', org: 'org-default', orgRole: null, tier: 'standard', platformRole: 'super-admin' }
};

function tokenFor(user, extra = {}) {
  return jwt.sign(
    {
      sub: user.id,
      id: user.id,
      username: user.id,
      role: user.platformRole || 'user',
      organization_id: user.org,
      compartment_access: user.tier,
      ...extra
    },
    config.JWT_SECRET
  );
}

/** Tokens for every user in USERS, keyed by the same names. */
function tokens() {
  return Object.fromEntries(Object.entries(USERS).map(([name, user]) => [name, tokenFor(user)]));
}

async function seedHiddenTier(pool, { policy = 'open' } = {}) {
  for (const [org, name] of [
    [ORG_A, 'Sec A'],
    [ORG_B, 'Sec B']
  ]) {
    await pool.query(
      `INSERT INTO organizations (id, name, slug, default_policy) VALUES ($1, $2, $1, $3)
       ON CONFLICT (id) DO UPDATE SET default_policy = EXCLUDED.default_policy`,
      [org, name, policy]
    );
  }

  const seen = new Set();
  for (const user of Object.values(USERS)) {
    if (seen.has(user.id)) continue;
    seen.add(user.id);
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id)
       VALUES ($1, $1, $2, 'x', $3, $4) ON CONFLICT (id) DO NOTHING`,
      [user.id, `${user.id}@sec.test`, user.platformRole || 'user', user.org]
    );
    if (user.orgRole) {
      await pool.query(
        `INSERT INTO memberships (id, user_id, organization_id, role) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, organization_id) DO NOTHING`,
        [`mem-${user.id}`, user.id, user.org, user.orgRole]
      );
    }
  }

  await pool.query(
    `INSERT INTO compartments (id, organization_id, name, slug, subnet_cidr, is_hidden) VALUES
       ($1, $2, 'Default Compartment', 'default', '100.64.0.0/24', FALSE),
       ($3, $2, 'Black Vault', 'black-vault', '100.64.99.0/24', TRUE),
       ($4, $2, 'Lab', 'lab', '100.64.50.0/24', FALSE)
     ON CONFLICT (id) DO NOTHING`,
    [DEFAULT_COMPARTMENT, ORG_A, HIDDEN_COMPARTMENT, LAB_COMPARTMENT]
  );

  let i = 0;
  for (const node of Object.values(NODES)) {
    i += 1;
    await pool.query(
      `INSERT INTO nodes (id, user_id, organization_id, compartment_id, name, public_key, overlay_ipv4, overlay_ipv6,
                          role, is_healthy, is_quarantined, country_code)
       VALUES ($1, $2, $3, $4, $1, $5, $6, $7, 'CLIENT_ORIGIN', TRUE, FALSE, 'IT')
       ON CONFLICT (id) DO NOTHING`,
      [node.id, node.user, node.org, node.compartment, `${i}`.repeat(64), node.vip, `fd7a:115c:a1e0::77:${i}`]
    );
  }
}

module.exports = {
  ORG_A,
  ORG_B,
  DEFAULT_COMPARTMENT,
  HIDDEN_COMPARTMENT,
  LAB_COMPARTMENT,
  NODES,
  USERS,
  tokenFor,
  tokens,
  seedHiddenTier
};
