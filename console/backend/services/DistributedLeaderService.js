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
    this._lease = null;
    this._timer = null;
    this._runId = 0;
    this._electionVersion = 0;
    this._startPromise = null;
    this._stopPromise = null;
    this._stepDownPromise = null;
    this._cyclePromise = null;
    this._leadershipAcquiredAt = null;
    this._lastHeartbeatAt = null;
    this._heartbeatIntervalMs = 5000;
    this._pauseUntil = 0;
    // Jobs running on this instance. A timer fires on schedule whether or not the
    // previous run has finished; a slow job must not start a second copy of itself.
    this._inFlight = new Set();
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
    if (this._stopPromise) {
      const runId = this._runId;
      await this._stopPromise;
      // A later stop also cancels starts queued behind an earlier shutdown.
      if (runId !== this._runId) return;
      return this.start({ heartbeatIntervalMs });
    }
    if (this._running) return this._startPromise;
    this._running = true;
    const runId = ++this._runId;
    this._heartbeatIntervalMs = heartbeatIntervalMs;

    logger.info(`[HA-LEADER] Starting leader election for instance '${this.instanceId}'`);
    const starting = (async () => {
      await this._electionCycle();
      if (!this._running || runId !== this._runId) return;

      this._timer = setInterval(() => {
        this._electionCycle().catch((err) => {
          logger.error(`[HA-LEADER] Error in election cycle: ${err.message}`);
        });
      }, this._heartbeatIntervalMs);

      // Unref timer so it does not block process termination in scripts
      this._timer.unref?.();
    })();
    this._startPromise = starting;
    try {
      await starting;
    } finally {
      if (this._startPromise === starting) this._startPromise = null;
    }
  }

  /**
   * Stop the service and release any held lock.
   */
  async stop() {
    this._running = false;
    this._runId++;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this._stopPromise) return this._stopPromise;
    const stopping = this.stepDown();
    this._stopPromise = stopping;
    try {
      await stopping;
    } finally {
      if (this._stopPromise === stopping) this._stopPromise = null;
    }
  }

  /**
   * Step down from leadership, unlocking the advisory lock and releasing client.
   * @param {Object} [options]
   * @param {number} [options.pauseReelectionMs=0] Optional delay before this instance attempts re-election
   */
  async stepDown({ pauseReelectionMs = 0 } = {}) {
    this._electionVersion++;
    const wasLeader = this._isLeader;
    this._isLeader = false;
    this._leadershipAcquiredAt = null;
    if (pauseReelectionMs > 0) {
      this._pauseUntil = Date.now() + pauseReelectionMs;
    }

    if (this._stepDownPromise) return this._stepDownPromise;
    const steppingDown = (async () => {
      // A queued connect or lock query still owns its eventual client. Drain it
      // before releasing the session, otherwise shutdown can publish a late leader.
      await this._cyclePromise;
      await this._releaseLease(this._lease);
      if (wasLeader) {
        this.emit('demoted', { instanceId: this.instanceId });
      }
    })();
    this._stepDownPromise = steppingDown;
    try {
      await steppingDown;
    } finally {
      if (this._stepDownPromise === steppingDown) this._stepDownPromise = null;
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

    if (this._inFlight.has(jobName)) {
      logger.warn(`[HA-LEADER] Skipping '${jobName}': the previous run has not finished`);
      return { executed: false, reason: 'IN_FLIGHT' };
    }

    this._inFlight.add(jobName);
    try {
      const result = await fn();
      return { executed: true, result };
    } catch (err) {
      logger.error(`[HA-LEADER] Job '${jobName}' failed on leader '${this.instanceId}': ${err.message}`);
      throw err;
    } finally {
      this._inFlight.delete(jobName);
    }
  }

  /**
   * Internal election loop.
   */
  async _electionCycle() {
    if (!this._running || this._stepDownPromise) return;
    if (this._lease?.releasePromise) return this._lease.releasePromise;
    if (this._pauseUntil && Date.now() < this._pauseUntil) return;
    // Advisory locks are session scoped and reentrant. Overlapping cycles could
    // acquire the same lock twice, leaving it held after a single unlock.
    if (this._cyclePromise) return this._cyclePromise;
    const cycle = this._runElectionCycle(this._electionVersion);
    this._cyclePromise = cycle;
    try {
      await cycle;
    } finally {
      if (this._cyclePromise === cycle) this._cyclePromise = null;
    }
  }

  _canElect(version, lease) {
    return this._running && version === this._electionVersion && !lease?.failed;
  }

  async _runElectionCycle(version) {
    const pool = this.pool || getPgPool();
    let lease = this._lease;

    try {
      if (this._isLeader && lease) {
        // Leader health-check query on dedicated connection
        const res = await lease.client.query('SELECT 1 as alive');
        if (!this._canElect(version, lease)) return;
        if (res && res.rows.length > 0) {
          this._lastHeartbeatAt = new Date();
          this.emit('heartbeat', { instanceId: this.instanceId, isLeader: true });
          return;
        }
      }

      // If we are not holding a dedicated client, obtain one from the pool
      if (!lease) {
        const client = await pool.connect();
        lease = { client, locked: false, failed: false, releasePromise: null };
        if (!this._canElect(version, lease)) {
          await this._releaseLease(lease);
          return;
        }
        this._lease = lease;
        this._client = client;
        lease.onError = (err) => {
          logger.warn(`[HA-LEADER] Dedicated leader connection error: ${err.message}`);
          this._handleClientFailure(lease);
        };
        client.on('error', lease.onError);
      }

      // Try acquiring session-level advisory lock
      const lockRes = await lease.client.query('SELECT pg_try_advisory_lock($1, $2) AS acquired', [
        LOCK_CLASS_ID,
        LOCK_OBJ_ID
      ]);

      const acquired = lockRes.rows[0]?.acquired === true;
      lease.locked = acquired;
      if (!this._canElect(version, lease)) {
        await this._releaseLease(lease);
        return;
      }

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
      }
      if (!acquired) {
        // We did not get the lock, release connection back so pool isn't exhausted by standbys
        await this._releaseLease(lease);
      }
    } catch (err) {
      logger.warn(`[HA-LEADER] Election attempt failed for '${this.instanceId}': ${err.message}`);
      this._handleClientFailure(lease);
      await lease?.releasePromise;
    }
  }

  async _releaseLease(lease) {
    if (!lease) return;
    if (lease.releasePromise) return lease.releasePromise;
    lease.releasePromise = (async () => {
      try {
        if (lease.locked && !lease.failed) {
          await lease.client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_CLASS_ID, LOCK_OBJ_ID]);
          logger.info(`[HA-LEADER] Released advisory lock for instance '${this.instanceId}'`);
        }
      } catch (err) {
        // An unlock failure must destroy the session; returning it idle would
        // leave an advisory lock available to an unrelated pool borrower.
        lease.failed = true;
        logger.warn(`[HA-LEADER] Error releasing advisory lock during step down: ${err.message}`);
      } finally {
        lease.locked = false;
        try {
          // pg-pool's release(true) starts closing without returning a promise.
          // Keep ownership until end completes so stop also drains idle failures.
          if (lease.failed) await lease.client.end();
        } finally {
          if (this._lease === lease) {
            this._lease = null;
            this._client = null;
          }
          if (lease.onError) lease.client.removeListener('error', lease.onError);
          lease.client.release(lease.failed);
        }
      }
    })();
    return lease.releasePromise;
  }

  _handleClientFailure(lease = this._lease) {
    if (!lease) return;
    lease.failed = true;
    const wasLeader = this._lease === lease && this._isLeader;
    if (this._lease === lease) {
      this._electionVersion++;
      this._isLeader = false;
      this._leadershipAcquiredAt = null;
    }
    this._releaseLease(lease).catch((err) => {
      logger.warn(`[HA-LEADER] Error discarding failed leader connection: ${err.message}`);
    });
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
