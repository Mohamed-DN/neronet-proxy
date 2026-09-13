/**
 * Heartbeat aggregation.
 *
 * Every node writes to the nodes table every 15 seconds. At 100,000 nodes that is
 * 6,667 UPDATEs per second through a pool of 20 connections, against a table
 * carrying 11 indexes -- and each UPDATE creates a new row version that autovacuum
 * then has to reclaim. Heartbeat state is hot, high-churn data with a natural
 * expiry, which is the shape of data a cache holds, not a relational table.
 *
 * Writes therefore land in Valkey and are flushed to the database periodically in
 * batches. At a 30-second interval that same fleet produces roughly 100 database
 * writes per second instead of 6,667, and reads stay current because list endpoints
 * merge the live values back over the stored ones.
 *
 * What this trades away: up to one flush interval of telemetry if Valkey is lost.
 * For counters and a last-seen timestamp that is an acceptable loss, and it is the
 * reason nothing else is routed through here -- registration and quarantine remain
 * straight database writes, because losing those would matter.
 */

const { getValkeyClient, NAMESPACE } = require('../db/valkey');
const { getDatabase, isPostgres, getPgPool } = require('../db/index');
const logger = require('../utils/logger');

const prefix = NAMESPACE ? `${NAMESPACE}:` : '';
const PENDING_SET = `${prefix}hb:pending`;
const nodeKey = (nodeId) => `${prefix}hb:node:${nodeId}`;

// Entries outlive several flush intervals so a flush that fails can be retried, but
// not so long that a node removed from the fleet lingers.
const ENTRY_TTL_SECONDS = 600;
const FLUSH_BATCH = 500;

let flushTimer = null;

/**
 * Record a heartbeat.
 *
 * Byte counters accumulate with HINCRBY so that several beats arriving between two
 * flushes add up rather than overwrite each other; gauges are last-write-wins,
 * which is what a gauge means.
 *
 * Returns false when Valkey is unavailable, so the caller can fall back to writing
 * straight to the database rather than silently dropping the beat.
 */
async function record(nodeId, metrics) {
  const client = getValkeyClient();
  if (!client) {
    return false;
  }

  const key = nodeKey(nodeId);

  try {
    await client
      .multi()
      .hincrby(key, 'tx_bytes', Math.trunc(metrics.txBytes || 0))
      .hincrby(key, 'rx_bytes', Math.trunc(metrics.rxBytes || 0))
      .hset(key, {
        cpu_usage_pct: String(metrics.cpuPct ?? 0),
        memory_usage_pct: String(metrics.memMb ?? 0),
        battery_pct: String(metrics.batteryPct ?? 0),
        // 0 means the node has not measured a round trip yet. It is stored as-is and
        // filtered at the point of use, so an unmeasured node is distinguishable
        // from one with a genuinely sub-millisecond path.
        latency_ms: String(metrics.rttMs ?? 0),
        last_heartbeat: new Date().toISOString()
      })
      .expire(key, ENTRY_TTL_SECONDS)
      .sadd(PENDING_SET, nodeId)
      .exec();

    return true;
  } catch (err) {
    logger.warn(`Heartbeat buffer write failed for ${nodeId}: ${err.message}`);
    return false;
  }
}

/**
 * Read buffered state for a set of nodes, so a read can show current values.
 *
 * Without this the console would lag the mesh by up to a flush interval, which
 * would trade a real scaling problem for a fresh honesty problem.
 */
async function readLive(nodeIds) {
  const client = getValkeyClient();
  if (!client || nodeIds.length === 0) {
    return new Map();
  }

  try {
    const pipeline = client.pipeline();
    for (const id of nodeIds) {
      pipeline.hgetall(nodeKey(id));
    }

    const results = await pipeline.exec();
    const live = new Map();

    results.forEach(([err, value], index) => {
      if (!err && value && Object.keys(value).length > 0) {
        live.set(nodeIds[index], value);
      }
    });

    return live;
  } catch (err) {
    logger.warn(`Heartbeat buffer read failed: ${err.message}`);
    return new Map();
  }
}

/** Merge buffered values over a stored row. */
function applyLive(row, live) {
  if (!live) return row;

  return {
    ...row,
    tx_bytes: Number(row.tx_bytes || 0) + Number(live.tx_bytes || 0),
    rx_bytes: Number(row.rx_bytes || 0) + Number(live.rx_bytes || 0),
    cpu_usage_pct: live.cpu_usage_pct !== undefined ? Number(live.cpu_usage_pct) : row.cpu_usage_pct,
    memory_usage_pct: live.memory_usage_pct !== undefined ? Number(live.memory_usage_pct) : row.memory_usage_pct,
    battery_pct: live.battery_pct !== undefined ? Number(live.battery_pct) : row.battery_pct,
    latency_ms: live.latency_ms !== undefined ? Number(live.latency_ms) : row.latency_ms,
    last_heartbeat: live.last_heartbeat || row.last_heartbeat
  };
}

/**
 * Write buffered heartbeats to the database and clear them.
 *
 * Claiming work with SPOP and then reading each hash inside a MULTI matters: a beat
 * arriving between the read and the delete would otherwise be discarded, and a node
 * beating every 15 seconds into a 30-second flush would lose beats routinely.
 */
async function flush() {
  const client = getValkeyClient();
  if (!client) {
    return { flushed: 0 };
  }

  let flushed = 0;

  try {
    for (;;) {
      const nodeIds = await client.spop(PENDING_SET, FLUSH_BATCH);
      if (!nodeIds || nodeIds.length === 0) {
        break;
      }

      // Read only. Deleting in the same transaction discarded the buffered counters
      // before the database write was known to have succeeded, so a lock timeout or
      // a dropped connection destroyed the telemetry it was meant to persist.
      const multi = client.multi();
      for (const id of nodeIds) {
        multi.hgetall(nodeKey(id));
      }

      const results = await multi.exec();

      const updates = [];
      nodeIds.forEach((id, index) => {
        const [err, value] = results[index];
        if (!err && value && Object.keys(value).length > 0) {
          updates.push({ nodeId: id, metrics: value });
        }
      });

      try {
        await persist(updates);
      } catch (err) {
        // Put the work back so the next flush retries it, instead of losing it.
        if (nodeIds.length > 0) {
          await client.sadd(PENDING_SET, ...nodeIds);
        }
        throw err;
      }

      // Only now is the data safely in the database.
      const cleanup = client.multi();
      for (const id of nodeIds) {
        cleanup.del(nodeKey(id));
      }
      await cleanup.exec();

      flushed += updates.length;

      if (nodeIds.length < FLUSH_BATCH) {
        break;
      }
    }
  } catch (err) {
    logger.error(`Heartbeat flush failed: ${err.message}`);
  }

  return { flushed };
}

/** Apply a batch of buffered heartbeats to the database. */
async function persist(updates) {
  if (updates.length === 0) return;

  if (isPostgres()) {
    const pool = getPgPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const { nodeId, metrics } of updates) {
        await client.query(
          `UPDATE nodes SET
             tx_bytes = tx_bytes + $1,
             rx_bytes = rx_bytes + $2,
             cpu_usage_pct = $3,
             memory_usage_pct = $4,
             battery_pct = $5,
             latency_ms = $6,
             is_healthy = TRUE,
             last_heartbeat = $7,
             updated_at = NOW()
           WHERE id = $8`,
          [
            Number(metrics.tx_bytes || 0),
            Number(metrics.rx_bytes || 0),
            Number(metrics.cpu_usage_pct || 0),
            Number(metrics.memory_usage_pct || 0),
            Number(metrics.battery_pct || 0),
            Number(metrics.latency_ms || 0),
            metrics.last_heartbeat || new Date().toISOString(),
            nodeId
          ]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return;
  }

  const db = getDatabase();
  const statement = db.prepare(
    `UPDATE nodes SET
       tx_bytes = tx_bytes + ?,
       rx_bytes = rx_bytes + ?,
       cpu_usage_pct = ?,
       memory_usage_pct = ?,
       battery_pct = ?,
       latency_ms = ?,
       is_healthy = 1,
       last_heartbeat = ?,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  );

  db.transaction(() => {
    for (const { nodeId, metrics } of updates) {
      statement.run(
        Number(metrics.tx_bytes || 0),
        Number(metrics.rx_bytes || 0),
        Number(metrics.cpu_usage_pct || 0),
        Number(metrics.memory_usage_pct || 0),
        Number(metrics.battery_pct || 0),
        Number(metrics.latency_ms || 0),
        metrics.last_heartbeat || new Date().toISOString(),
        nodeId
      );
    }
  })();
}

function startFlusher(intervalMs = Number(process.env.SOVEREIGN_HEARTBEAT_FLUSH_MS || 30_000)) {
  if (flushTimer) return flushTimer;

  flushTimer = setInterval(() => {
    flush().catch((err) => logger.error(`Heartbeat flusher: ${err.message}`));
  }, intervalMs);

  // Do not hold the process open for a flush that can simply happen next time.
  if (typeof flushTimer.unref === 'function') flushTimer.unref();

  logger.info(`Heartbeat flusher started (every ${Math.round(intervalMs / 1000)}s).`);
  return flushTimer;
}

function stopFlusher() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

module.exports = {
  record,
  readLive,
  applyLive,
  flush,
  startFlusher,
  stopFlusher,
  PENDING_SET
};
