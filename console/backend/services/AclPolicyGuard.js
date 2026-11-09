/**
 * Policy guard (ADR 0028 pair 1): stored assertions checked on every ACL save.
 *
 * An administrator records what the network must do ("100.64.20.1 reaches
 * 100.64.20.2 on TCP 22", or "is dropped"). Every write that can change a verdict --
 * a rule created, updated, disabled or deleted, or the default policy changed -- is
 * evaluated first against the candidate rule set of every organisation it reaches,
 * with the same function the simulator uses, and refused when an assertion would
 * break. Nothing is written for a refused save.
 *
 * The check and the write run under one PostgreSQL advisory lock, so two saves that
 * are each safe cannot together break an assertion: the second one is evaluated
 * against the first one's result.
 */
const crypto = require('crypto');
const { getPgPool } = require('../db/index');
const AclEngine = require('./AclEngine');

// 0x0A1C0028: "ACL", ADR 0028. Any constant works as long as only this guard takes it.
const LOCK_KEY = 0x0a1c0028;
const PROTOCOLS = new Set(['TCP', 'UDP', 'ICMP', 'ALL']);
const VERDICTS = new Set(['ACCEPT', 'DROP']);

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

/** Run fn while holding the guard's lock. Released on every path, also on a throw. */
async function withPolicyLock(fn) {
  const client = await getPgPool().connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

/** A rule in the shape AclEngine stores and evaluates, from a request body. */
function normalizeRule(rule, organizationId) {
  return {
    id: rule.id,
    priority: Number(rule.priority) || 100,
    source_cidr: rule.source_cidr || '0.0.0.0/0',
    destination_cidr: rule.destination_cidr || '0.0.0.0/0',
    protocol: String(rule.protocol || 'ALL').toUpperCase(),
    port_start: Number(rule.port_start) || 0,
    port_end: Number.isFinite(Number(rule.port_end)) ? Number(rule.port_end) : 65535,
    action: String(rule.action || 'ACCEPT').toUpperCase(),
    description: rule.description || '',
    enabled: rule.enabled === undefined ? true : Boolean(rule.enabled),
    organization_id: organizationId
  };
}

/** The rule an update would leave, merged the way AclEngine.updateRule merges it. */
function mergeUpdate(existing, updates) {
  const pick = (k) => (updates[k] !== undefined ? updates[k] : existing[k]);
  return normalizeRule(
    {
      id: existing.id,
      priority: pick('priority'),
      source_cidr: pick('source_cidr'),
      destination_cidr: pick('destination_cidr'),
      protocol: pick('protocol'),
      port_start: pick('port_start'),
      port_end: pick('port_end'),
      action: pick('action'),
      description: pick('description'),
      enabled: pick('enabled')
    },
    existing.organization_id
  );
}

const byEvaluationOrder = (a, b) =>
  Number(a.priority) - Number(b.priority) || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);

/**
 * The enabled rules that would apply to organisationId's nodes after `change`.
 *
 * change: { kind: 'create', rule } | { kind: 'update', rule } | { kind: 'delete', id } | null.
 * For create and update, `rule` is already normalised and carries organization_id.
 */
async function candidateRules(organizationId, change) {
  let rules = await AclEngine.listRules(organizationId);
  if (!change) return rules;

  const removedId = change.kind === 'delete' ? change.id : change.rule && change.rule.id;
  rules = rules.filter((r) => r.id !== removedId);

  if (change.kind === 'create' || change.kind === 'update') {
    const r = change.rule;
    const applies = r.organization_id === null || r.organization_id === organizationId;
    if (r.enabled && applies) rules.push(r);
  }
  return rules.sort(byEvaluationOrder);
}

async function defaultPolicyOf(organizationId) {
  const res = await getPgPool().query('SELECT default_policy FROM organizations WHERE id = $1', [organizationId]);
  return (res.rows[0] && res.rows[0].default_policy) || 'deny';
}

async function listTests(organizationId) {
  const res = await getPgPool().query(
    `SELECT id, organization_id, host(source_ip) AS source_ip, host(destination_ip) AS destination_ip,
            protocol, port, expect, description, created_by, created_at
       FROM acl_policy_tests WHERE organization_id = $1 ORDER BY created_at ASC, id ASC`,
    [organizationId]
  );
  return res.rows;
}

/** The organisations whose assertions a rule change can break. */
async function organisationsReachedBy(ruleOrganizationId) {
  if (ruleOrganizationId) return [ruleOrganizationId];
  const res = await getPgPool().query('SELECT DISTINCT organization_id FROM acl_policy_tests ORDER BY organization_id');
  return res.rows.map((r) => r.organization_id);
}

/** Assertions of one organisation that the given rule set and default policy break. */
async function failingTests({ organizationId, rules, defaultPolicy, tests = null }) {
  const failures = [];
  for (const t of tests || (await listTests(organizationId))) {
    // Root tier: an assertion is about the real policy, not about what its author sees.
    const result = await AclEngine.simulatePacket({
      source_ip: t.source_ip,
      destination_ip: t.destination_ip,
      protocol: t.protocol,
      port: Number(t.port),
      defaultPolicy,
      organizationId,
      accessTier: 'root',
      rules
    });
    if (result.verdict !== t.expect) {
      failures.push({
        test_id: t.id || null,
        organization_id: organizationId,
        description: t.description || '',
        source_ip: t.source_ip,
        destination_ip: t.destination_ip,
        protocol: t.protocol,
        port: Number(t.port),
        expect: t.expect,
        got: result.verdict,
        reason: result.reason
      });
    }
  }
  return failures;
}

/**
 * Failures a change would cause, across every organisation it reaches.
 *
 * change:
 *   { kind: 'create', rule }          rule normalised, with organization_id
 *   { kind: 'update', rule }          the merged rule after the update
 *   { kind: 'delete', id, organizationId }
 *   { kind: 'default-policy', organizationId, defaultPolicy }
 */
async function failuresFor(change) {
  if (change.kind === 'default-policy') {
    const rules = await candidateRules(change.organizationId, null);
    return failingTests({ organizationId: change.organizationId, rules, defaultPolicy: change.defaultPolicy });
  }
  const ruleOrg = change.kind === 'delete' ? change.organizationId : change.rule.organization_id;
  const failures = [];
  for (const orgId of await organisationsReachedBy(ruleOrg)) {
    const rules = await candidateRules(orgId, change);
    failures.push(
      ...(await failingTests({ organizationId: orgId, rules, defaultPolicy: await defaultPolicyOf(orgId) }))
    );
  }
  return failures;
}

/** The error a refused save answers with. */
function refusal(failures) {
  const err = new Error('policy_tests_failed');
  err.status = 409;
  err.failures = failures;
  return err;
}

/** Throw a 409 refusal when the change would break an assertion. */
async function assertChangeAllowed(change) {
  const failures = await failuresFor(change);
  if (failures.length > 0) throw refusal(failures);
}

function validateTest(body) {
  const t = body || {};
  for (const field of ['source_ip', 'destination_ip']) {
    const ip = String(t[field] || '').trim();
    if (!ip || ip.includes('/') || !AclEngine.parseCidr(ip)) throw badRequest(`${field} must be an IPv4 address`);
  }
  const protocol = String(t.protocol || 'ALL').toUpperCase();
  if (!PROTOCOLS.has(protocol)) throw badRequest('protocol must be TCP, UDP, ICMP or ALL');
  const port = t.port === undefined || t.port === null || t.port === '' ? 0 : Number(t.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw badRequest('port must be an integer from 0 to 65535');
  const expect = String(t.expect || '').toUpperCase();
  if (!VERDICTS.has(expect)) throw badRequest('expect must be ACCEPT or DROP');
  const description = String(t.description || '');
  if (description.length > 500) throw badRequest('description is limited to 500 characters');
  return {
    source_ip: String(t.source_ip).trim(),
    destination_ip: String(t.destination_ip).trim(),
    protocol,
    port,
    expect,
    description
  };
}

/** Store an assertion, refused when the current policy already breaks it. Takes the lock. */
async function createTest(organizationId, body, actorId) {
  const test = validateTest(body);
  return withPolicyLock(async () => {
    const failures = await failingTests({
      organizationId,
      rules: await candidateRules(organizationId, null),
      defaultPolicy: await defaultPolicyOf(organizationId),
      tests: [test]
    });
    if (failures.length > 0) throw refusal(failures);

    const id = `apt-${crypto.randomBytes(6).toString('hex')}`;
    await getPgPool().query(
      `INSERT INTO acl_policy_tests (id, organization_id, source_ip, destination_ip, protocol, port, expect, description, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        organizationId,
        test.source_ip,
        test.destination_ip,
        test.protocol,
        test.port,
        test.expect,
        test.description,
        actorId
      ]
    );
    return (await listTests(organizationId)).find((t) => t.id === id);
  });
}

/** Delete an assertion of this organisation. False when there is none by that id. */
async function deleteTest(organizationId, id) {
  const res = await getPgPool().query(
    'DELETE FROM acl_policy_tests WHERE id = $1 AND organization_id = $2 RETURNING id',
    [id, organizationId]
  );
  return res.rows.length > 0;
}

/** Run an organisation's assertions against its current policy. */
async function runTests(organizationId) {
  const tests = await listTests(organizationId);
  const failures = await failingTests({
    organizationId,
    rules: await candidateRules(organizationId, null),
    defaultPolicy: await defaultPolicyOf(organizationId),
    tests
  });
  return { total: tests.length, failures };
}

module.exports = {
  withPolicyLock,
  normalizeRule,
  mergeUpdate,
  candidateRules,
  failingTests,
  failuresFor,
  assertChangeAllowed,
  listTests,
  createTest,
  deleteTest,
  runTests
};
