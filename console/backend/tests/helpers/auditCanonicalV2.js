// Frozen historical v2 producer, independent of the current production writer.
const crypto = require('node:crypto');
const config = require('../../config/env');

function json(value) {
  if (Array.isArray(value)) return `[${value.map(json).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${json(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

async function appendHistoricalV2(pool, options = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE audit_events IN SHARE ROW EXCLUSIVE MODE');
    const previous = (
      await client.query(
        'SELECT sequence_num,entry_hash FROM audit_events WHERE sequence_num IS NOT NULL ORDER BY sequence_num DESC LIMIT 1'
      )
    ).rows[0];
    const id = (await client.query("SELECT nextval(pg_get_serial_sequence('audit_events','id')) AS id")).rows[0].id;
    const at = options.createdAt || new Date();
    const metadata = options.metadataText ?? json(options.metadata ?? { nested: { value: 'historical-v2' } });
    const row = {
      id,
      sequence_num: Number(previous?.sequence_num || 0) + 1,
      prev_hash: previous?.entry_hash || '0'.repeat(64),
      event_type: options.eventType || 'HISTORICAL_V2',
      severity: options.severity || 'info',
      actor_user_id: options.actorUserId ?? null,
      actor_username: options.actorUsername ?? 'operator',
      target_id: options.targetId ?? null,
      target_type: options.targetType ?? 'historical-fixture',
      message: options.message ?? 'Historical v2 evidence',
      ip_address: options.ipAddress ?? '127.0.0.1',
      user_agent: options.userAgent ?? 'NeroNet-historical/2',
      created_at: at,
      canonical_metadata_json: metadata,
      hmac_key_id: crypto
        .createHmac('sha256', config.AUDIT_HMAC_SECRET)
        .update('neronet-audit-hmac-key-id-v1')
        .digest('hex')
        .slice(0, 16)
    };
    const nullable = (value) => (value == null ? null : String(value));
    const bytes = json([
      'neronet.audit.event',
      2,
      String(id),
      String(row.sequence_num),
      row.prev_hash,
      row.event_type,
      row.severity,
      nullable(row.actor_user_id),
      nullable(row.actor_username),
      nullable(row.target_id),
      nullable(row.target_type),
      nullable(row.message),
      nullable(row.ip_address),
      nullable(row.user_agent),
      at.toISOString().replace(/\.(\d{3})Z$/, '.$1000Z'),
      metadata,
      row.hmac_key_id
    ]);
    const hash = crypto.createHmac('sha256', config.AUDIT_HMAC_SECRET).update(bytes, 'utf8').digest('hex');
    const result = await client.query(
      `INSERT INTO audit_events(id,sequence_num,prev_hash,entry_hash,event_type,
      severity,actor_user_id,actor_username,target_id,target_type,message,ip_address,user_agent,created_at,
      metadata_json,hmac_key_id,canonical_version,canonical_metadata_json)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::text::jsonb,$16,2,$15::text) RETURNING *`,
      [
        id,
        row.sequence_num,
        row.prev_hash,
        hash,
        row.event_type,
        row.severity,
        row.actor_user_id,
        row.actor_username,
        row.target_id,
        row.target_type,
        row.message,
        row.ip_address,
        row.user_agent,
        at,
        metadata,
        row.hmac_key_id
      ]
    );
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { appendHistoricalV2 };
