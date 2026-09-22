// ==============================================================================
// NeroNet Sovereign Mesh - Distributed Leadership Service
// Implements ADR 0001: PostgreSQL Advisory Lock Leader Election for N Control Planes
// Ensures periodic background tasks (heartbeat flush, token cleanup, canary)
// execute on exactly ONE instance at a time, with zero-downtime failover.
// ==============================================================================

const EventEmitter = require('events');
const { getPgPool } = require('../db');
const logger = require('../utils/logger');

// Lock namespace: ASCII 'NERO' (0x4E45524F = 1313165886), 'LEAD' (0x4C454144 = 1279607108)
const LOCK_CLASS_ID = 1313165886;
const LOCK_OBJ_ID = 1279607108;

class DistributedLeaderService extends EventEmitter {
  constructor({ pool = null, instanceId = null } = {}) {
    super();
    this.pool = pool;
    this.instanceId = instanceId || process.env.INSTANCE_ID || `cp-${process.pid}-${Date.now()}`;
    this._isLeader = false;
    this._running = false;
    this._client = null;
    this._timer = null;
    this._leadershipAcquiredAt = null;
    this._lastHeartbeatAt = null;
    this._heartbeatIntervalMs = 5000;
    this._pauseUntil = 0;
  }

  get isLeader() {
    return this._isLeader;
  }

  getInstanceId() {
    return this.instanceId;
  }

  getStatus() {
    return {
      instanceId: this.instanceId,
      isLeader: this._isLeader,
      leadershipAcquiredAt: this._leadershipAcquiredAt ? this._leadershipAcquiredAt.toISOString() : null,
      lastHeartbeatAt: this._lastHeartbeatAt ? this._lastHeartbeatAt.toISOString() : null
    };
  }

  /**
   * Start the leader election background loop.
   */
  async start({ heartbeatIntervalMs = 500 } = {}) {
    if (this._running) return;
    this._running = true;
    this._heartbeatIntervalMs = heartbeatIntervalMs;

    logger.info(`[HA-LEADER] Starting leader election for instance '${this.instanceId}'`);
    await this._electionCycle();

    this._timer = setInterval(() => {
      this._electionCycle().catch((err) => {
        logger.error(`[HA-LEADER] Error in election cycle: ${err.message}`);
      });
    }, this._heartbeatIntervalMs);

    // Unref timer so it does not block process termination in scripts
    if (this._timer && typeof this._timer.unref === 'function') {
      this._timer.unref();
    }
  }

  /**
   * Stop the service and release any held lock.
   */
  async stop() {
    this._running = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    await this.stepDown();
  }

  /**
   * Step down from leadership, unlocking the advisory lock and releasing client.
   * @param {Object} [options]
   * @param {number} [options.pauseReelectionMs=0] Optional delay before this instance attempts re-election
   */
  async stepDown({ pauseReelectionMs = 0 } = {}) {
    const wasLeader = this._isLeader;
    this._isLeader = false;
    this._leadershipAcquiredAt = null;
    if (pauseReelectionMs > 0) {
      this._pauseUntil = Date.now() + pauseReelectionMs;
    }

    if (this._client) {
      try {
        if (wasLeader) {
          await this._client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_CLASS_ID, LOCK_OBJ_ID]);
          logger.info(`[HA-LEADER] Released advisory lock for instance '${this.instanceId}'`);
        }
      } catch (err) {
        logger.warn(`[HA-LEADER] Error releasing advisory lock during step down: ${err.message}`);
      } finally {
        try {
          this._client.release();
        } catch (_) {}
        this._client = null;
      }
    }

    if (wasLeader) {
      this.emit('demoted', { instanceId: this.instanceId });
    }
  }

  /**
   * Execute a task only if this instance is currently the leader.
   * Prevents duplicate execution across multiple control plane nodes.
   */
  async executeAsLeader(jobName, fn) {
    if (!this._isLeader) {
      logger.debug(`[HA-LEADER] Skipping '${jobName}': instance '${this.instanceId}' is standby`);
      return { executed: false, reason: 'NOT_LEADER' };
    }

    try {
      const result = await fn();
      return { executed: true, result };
    } catch (err) {
      logger.error(`[HA-LEADER] Job '${jobName}' failed on leader '${this.instanceId}': ${err.message}`);
      throw err;
    }
  }

  /**
   * Internal election loop.
   */
  async _electionCycle() {
    if (!this._running) return;
    if (this._pauseUntil && Date.now() < this._pauseUntil) return;
    const pool = this.pool || getPgPool();

    try {
      if (this._isLeader && this._client) {
        // Leader health-check query on dedicated connection
        const res = await this._client.query('SELECT 1 as alive');
        if (res && res.rows.length > 0) {
          this._lastHeartbeatAt = new Date();
          this.emit('heartbeat', { instanceId: this.instanceId, isLeader: true });
          return;
        }
      }

      // If we are not holding a dedicated client, obtain one from the pool
      if (!this._client) {
        this._client = await pool.connect();
        this._client.on('error', (err) => {
          logger.warn(`[HA-LEADER] Dedicated leader connection error: ${err.message}`);
          this._handleClientFailure();
        });
      }

      // Try acquiring session-level advisory lock
      const lockRes = await this._client.query(
        'SELECT pg_try_advisory_lock($1, $2) AS acquired',
        [LOCK_CLASS_ID, LOCK_OBJ_ID]
      );

      const acquired = lockRes.rows[0]?.acquired === true;

      if (acquired && !this._isLeader) {
        this._isLeader = true;
        this._leadershipAcquiredAt = new Date();
        this._lastHeartbeatAt = new Date();
        logger.info(`[HA-LEADER] Instance '${this.instanceId}' ACQUIRED leadership`);
        this.emit('promoted', { instanceId: this.instanceId });
      } else if (!acquired && this._isLeader) {
        this._isLeader = false;
        this._leadershipAcquiredAt = null;
        logger.warn(`[HA-LEADER] Instance '${this.instanceId}' LOST leadership`);
        this.emit('demoted', { instanceId: this.instanceId });
      } else if (!acquired) {
        // We did not get the lock, release connection back so pool isn't exhausted by standbys
        if (this._client) {
          try {
            this._client.release();
          } catch (_) {}
          this._client = null;
        }
      }
    } catch (err) {
      logger.warn(`[HA-LEADER] Election attempt failed for '${this.instanceId}': ${err.message}`);
      this._handleClientFailure();
    }
  }

  _handleClientFailure() {
    const wasLeader = this._isLeader;
    this._isLeader = false;
    this._leadershipAcquiredAt = null;
    if (this._client) {
      try {
        this._client.release();
      } catch (_) {}
      this._client = null;
    }
    if (wasLeader) {
      this.emit('demoted', { instanceId: this.instanceId });
    }
  }
}

// Global default singleton instance
let defaultLeaderService = null;

function getDistributedLeaderService(options) {
  if (!defaultLeaderService || options) {
    defaultLeaderService = new DistributedLeaderService(options);
  }
  return defaultLeaderService;
}

module.exports = {
  DistributedLeaderService,
  getDistributedLeaderService,
  LOCK_CLASS_ID,
  LOCK_OBJ_ID
};
