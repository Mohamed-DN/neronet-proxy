const { issueConsoleTestToken } = require('./consoleSession');

const ORG_A = 'org-sec-a';
const ORG_B = 'org-sec-b';

// name -> [organisation, membership role, platform role]
const ACTORS = {
  ownerA: [ORG_A, 'owner', 'user'],
  adminA: [ORG_A, 'admin', 'user'],
  netAdminA: [ORG_A, 'network_admin', 'user'],
  auditorA: [ORG_A, 'auditor', 'user'],
  memberA: [ORG_A, 'member', 'user'],
  member2A: [ORG_A, 'member', 'user'],
  adminB: [ORG_B, 'admin', 'user'],
  memberB: [ORG_B, 'member', 'user']
};

/**
 * Two organisations and one user per role, each with a real console session.
 * Returns { tokens, ids, orgs } keyed by the names in ACTORS, plus `superAdmin`.
 */
async function createOrgFixture(pool) {
  await pool.query(
    `INSERT INTO organizations (id, name, slug, default_policy) VALUES
       ($1, 'Sec A', 'sec-a', 'open'), ($2, 'Sec B', 'sec-b', 'open') ON CONFLICT (id) DO NOTHING`,
    [ORG_A, ORG_B]
  );
  const tokens = {};
  const ids = {};
  for (const [name, [org, role, platformRole]] of Object.entries(ACTORS)) {
    const id = `usr-sec-${name.toLowerCase()}`;
    ids[name] = id;
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id)
       VALUES ($1, $2, $3, 'x', $4, $5) ON CONFLICT (id) DO NOTHING`,
      [id, `sec_${name.toLowerCase()}`, `${name.toLowerCase()}@sec.local`, platformRole, org]
    );
    await pool.query(
      `INSERT INTO memberships (id, user_id, organization_id, role) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [`mem-sec-${name.toLowerCase()}`, id, org, role]
    );
    tokens[name] = await issueConsoleTestToken({
      sub: id,
      id,
      username: `sec_${name.toLowerCase()}`,
      role: platformRole,
      organization_id: org,
      org_role: role
    });
  }
  await pool.query(
    `INSERT INTO users (id, username, email, password_hash, role, organization_id)
     VALUES ('usr-sec-super', 'sec_super', 'super@sec.local', 'x', 'super-admin', 'org-default') ON CONFLICT (id) DO NOTHING`
  );
  tokens.superAdmin = await issueConsoleTestToken({
    sub: 'usr-sec-super',
    id: 'usr-sec-super',
    username: 'sec_super',
    role: 'super-admin'
  });
  return { tokens, ids, orgs: { A: ORG_A, B: ORG_B } };
}

module.exports = { createOrgFixture, ORG_A, ORG_B };
