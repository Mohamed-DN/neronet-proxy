/**
 * Unique mesh names for profile devices (ADR 0034, phase 2).
 *
 * A name is the slug of the device's label plus the organisation's search domain. Two devices
 * of one organisation never share one: the second "Phone" becomes phone-2, the third phone-3,
 * in the order they were created. migrations/053_device_dns_names.sql backfills the rows that
 * exist and puts a unique index (organization_id, dns_name) under the rule.
 */
const { slugLabel, labelWithSuffix } = require('../utils/meshNames');

/** The unique index of migration 053; a violation of any other constraint is not ours to retry. */
const DNS_NAME_INDEX = 'idx_nodes_org_dns_name_unique';
const MAX_ATTEMPTS = 100;
const SAVEPOINT = 'device_dns_name';

function exhausted() {
  // The caller turns a 23505 that is not about the key into 503 try_again, never a 500.
  return Object.assign(new Error('no free device name found'), { code: '23505', constraint: `${DNS_NAME_INDEX}_exhausted` });
}

async function firstFree(client, organizationId, label, searchDomain, from) {
  for (let n = from; n < from + MAX_ATTEMPTS; n++) {
    const candidate = `${labelWithSuffix(label, n)}.${searchDomain}`;
    const taken = await client.query('SELECT 1 FROM nodes WHERE organization_id = $1 AND dns_name = $2 LIMIT 1', [
      organizationId,
      candidate
    ]);
    if (taken.rows.length === 0) return { n, dnsName: candidate };
  }
  throw exhausted();
}

/**
 * Run `insert(dnsName)` with the first free name for `name`, inside the caller's transaction.
 * Should another transaction take that name first, the unique index refuses the insert; the
 * savepoint undoes only that statement and the next suffix is tried. A name with nothing
 * left of it after slugging (all symbols) gets no dns_name: `insert(null)`.
 * Resolves to the name that was stored, or null.
 */
async function insertWithDnsName(client, { organizationId, name, searchDomain }, insert) {
  const label = slugLabel(name);
  if (!label) {
    await insert(null);
    return null;
  }
  let from = 1;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const free = await firstFree(client, organizationId, label, searchDomain, from);
    await client.query(`SAVEPOINT ${SAVEPOINT}`);
    try {
      await insert(free.dnsName);
      await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
      return free.dnsName;
    } catch (err) {
      if (!err || err.code !== '23505' || err.constraint !== DNS_NAME_INDEX) throw err;
      await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
      from = free.n + 1;
    }
  }
  throw exhausted();
}

module.exports = { insertWithDnsName, DNS_NAME_INDEX };
