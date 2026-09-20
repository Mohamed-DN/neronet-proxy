# NeroNet Sovereign Mesh Enterprise Console — High Availability (HA) Architecture & Scaling Guide

> Design document from an earlier phase. It has not been checked against the code. Where it differs from [the handbook](HANDBOOK.md), the handbook is right. The high-availability design is not built; the decision is in [ADR 0001](adr/0001-no-multi-master-postgresql.md).

**Document Version:** 4.0.0 (v5.0 Enterprise Ready)  
**Target Audience:** Site Reliability Engineers, Enterprise Architects, Security Operations  
**Applies to:** NeroNet Control Plane Backend, Enterprise Management Console, PostgreSQL 16 & Valkey 7  

---

## 1. Executive Overview

The **NeroNet Enterprise Management Console** serves as the mission-control plane for large-scale sovereign mesh networks. In enterprise environments, high availability (HA) is critical: control plane failure must never partition existing WireGuard/Noise data planes, and state updates (such as node quarantine, key rotation, and cross-mesh peering) must propagate instantaneously across all API replicas.

This document details the multi-tier High Availability architecture:
1. **Control Plane Active-Active Replicas** via Valkey Pub/Sub state synchronization.
2. **PostgreSQL 16 Primary-Standby Streaming Replication** roadmap and Patroni failover blueprint.
3. **Valkey 7 Distributed State & Session Clustering**.
4. **Disaster Recovery, Split-Brain Protection, and Zero-Downtime Deployment**.

```
+---------------------------------------------------------------------------------------------------------------+
|                                    ENTERPRISE LOAD BALANCER / L7 INGRESS                                      |
|                                       (TLS Termination, Health Probes)                                        |
+---------------------------------------------------------------------------------------------------------------+
                                         │                                │
                       Round-Robin / Session Affinity            Sticky WebSocket Upgrade
                                         │                                │
                 +───────────────────────┴────────────────────────────────┴───────────────────────+
                 │                                                                               │
+────────────────▼───────────────────────────────+               +───────────────────────────────▼───────────────+
|         API REPLICA 1 (Node.js 22)             |               |         API REPLICA 2 (Node.js 22)             |
|  - REST Control Plane Endpoints                |               |  - REST Control Plane Endpoints                |
|  - WebSocket Hub (/ws/topology) [Clients: 150] |               |  - WebSocket Hub (/ws/topology) [Clients: 220] |
|  - Local In-Memory Token Blacklist Cache       |               |  - Local In-Memory Token Blacklist Cache       |
+────────────────┬───────────────────────────────+               +───────────────────────────────┬───────────────+
                 │                                                                               │
                 │ Pub/Sub: neronet:topology:events                              Pub/Sub: neronet:topology:events
                 │ Token Blacklist & Rate Limits                                 Token Blacklist & Rate Limits
                 │                                                                               │
+────────────────▼───────────────────────────────────────────────────────────────────────────────▼───────────────+
|                                VALKEY 7 CLUSTER / HIGH AVAILABILITY PAIR                                      |
|  - Active-Active Pub/Sub Event Bus                                                                             |
|  - Global Token Revocation Blacklist (O(1) lookups with TTL)                                                   |
|  - Real-Time Rate Limiting & Distributed Mutexes                                                               |
+────────────────────────────────────────────────┬───────────────────────────────────────────────────────────────+
                                                 │
                                SQL Read/Write   │   SQL Read-Only (Optional Pool)
                                                 │
+────────────────────────────────────────────────▼───────────────────────────────────────────────────────────────+
|                                    PGBOUNCER CONNECTION POOL                                                   |
+────────────────────────────────────────────────┬───────────────────────────────────────────────────────────────+
                                                 │
                         +───────────────────────┴───────────────────────+
                         │ (Synchronous / Asynchronous WAL Streaming)    │
                         ▼                                               ▼
+────────────────────────────────────────────────+               +───────────────────────────────────────────────+
|        POSTGRESQL 16 PRIMARY (RW)              | ────────────> |        POSTGRESQL 16 STANDBY (RO)             |
|  - Master Data Store                           |   Streaming   |  - Hot Standby Read Replica                   |
|  - PostGIS Geometry (Point, 4326)              |   WAL Log     |  - Automated Patroni / Raft Failover Target   |
|  - pgvector AI Anomaly Embeddings (1536)       |               |  - Zero Schema Changes Required               |
+────────────────────────────────────────────────+               +───────────────────────────────────────────────+
```

---

## 2. Control Plane Active-Active API Architecture

### 2.1 Multi-Instance State Synchronization via Valkey Pub/Sub

The NeroNet Control Plane backend is architected as a stateless microservice running $N$ identical container replicas behind a reverse proxy (e.g., Nginx, Envoy, or Cloudflare).

When an administrative action or automated engine alters mesh state (e.g., an automated quarantine trigger from the Behavioral Risk Engine, a node key rotation, or a cross-mesh peering agreement acceptance), all connected web browsers and client applications across all API replicas must receive immediate notification.

#### Event Propagation Pipeline:
1. **Mutation Ingestion:** API Replica $A$ receives a mutation request (e.g., `POST /api/nodes/:id/quarantine`).
2. **Database Persistence:** Replica $A$ commits the row update to PostgreSQL 16 within a transaction.
3. **Pub/Sub Publish:** Replica $A$ publishes the event payload to Valkey 7 channel `neronet:topology:events` via `TopologySync.publishTopologyEvent()`.
4. **Replica Fanout:** All running API replicas (including Replica $B$ and Replica $C$) subscribe to `neronet:topology:events`. Upon message receipt, each replica iterates through its active WebSocket connections (`/ws/topology`) and pushes the event to connected frontend clients.
5. **UI Update:** The React frontend receives the WebSocket message and instantly updates the 3D topology graph, node matrix, and dashboard gauges with zero polling overhead.

#### Event Envelope Format:
```json
{
  "event": "NODE_QUARANTINED",
  "nodeId": "svrn-node-east-04",
  "userId": "usr-enterprise-01",
  "reason": "Impossible travel velocity anomaly (>1000km/h)",
  "overlayIpv4": "100.64.250.4",
  "riskScore": 85,
  "timestamp": "2026-09-01T04:15:00.000Z"
}
```

### 2.2 Token Revocation & Session Management

To ensure instant revocation without relational database polling on every request:
- When a user logs out (`POST /api/auth/logout`) or an account is deleted via NeroNuke (`POST /api/nuke/user/self-destruct`), the JWT SHA-256 hash is immediately stored in Valkey 7 under key `blacklist:token:<hash>` with a TTL matching the token's remaining lifespan.
- Each API replica maintains an in-memory local cache of recently blacklisted hashes and queries Valkey in O(1) time during middleware authentication.
- Any subsequent request bearing the revoked token is rejected with HTTP 401 across all API replicas instantly.

---

## 3. PostgreSQL 16 High Availability & Streaming Replication

### 3.1 Local Staging vs. Enterprise Production

In the local staging environment (`docker-compose.yml`), a single PostgreSQL 16 container (`postgis/postgis:16-3.4-alpine`) is deployed to conserve local host memory while maintaining full functional compatibility (JSONB, PostGIS, pgvector).

However, the schema, configuration templates, and connection pool settings are engineered to support **zero-downtime streaming replication** when deploying to multi-node enterprise environments.

### 3.2 Production PostgreSQL Configuration (`postgresql.conf`)

To activate physical streaming replication on the Primary node, configure the following parameters:

```ini
# ==============================================================================
# NeroNet PostgreSQL 16 - High Availability Configuration
# ==============================================================================

# Replication & WAL Settings
wal_level = replica                     # Enables WAL streaming to standby replicas
max_wal_senders = 10                    # Maximum concurrent replication connections
max_replication_slots = 10              # Retains WAL files until standby consumes them
wal_keep_size = 1024MB                  # Retains 1GB of WAL segments in pg_wal
wal_compression = on                    # Compresses WAL records to minimize bandwidth

# Synchronous vs. Asynchronous Replication Modes
# For Zero-RPO (Strict Zero Data Loss):
synchronous_commit = on
synchronous_standby_names = 'FIRST 1 (neronet_standby_01, neronet_standby_02)'

# Standby Server Parameters (Applied on Standby nodes)
hot_standby = on                        # Allows read-only queries while in recovery
hot_standby_feedback = on               # Prevents query cancellation on read replicas

# Checkpointing & Memory
checkpoint_completion_target = 0.9
max_connections = 200
shared_buffers = 4GB
work_mem = 64MB
maintenance_work_mem = 512MB
```

### 3.3 Replication User & `pg_hba.conf` Security

Create a dedicated, least-privilege replication user on the Primary:

```sql
-- Execute on Primary Node
CREATE ROLE replicator WITH REPLICATION LOGIN ENCRYPTED PASSWORD 'StrongReplicationPassword2026!';
```

Configure `pg_hba.conf` on the Primary to allow standby nodes to connect over an encrypted TLS tunnel:

```
# TYPE  DATABASE        USER            ADDRESS                 METHOD
hostssl replication     replicator      172.28.0.0/16           scram-sha-256
hostssl neronet_db      neronet         172.28.0.0/16           scram-sha-256
```

### 3.4 Initializing Standby Node (`pg_basebackup`)

To provision a new standby replica from a running Primary:

```bash
# Execute on Standby Node host
pg_basebackup \
  -h postgres-primary.internal.darknero.com \
  -p 5432 \
  -U replicator \
  -D /var/lib/postgresql/data \
  -Fp \
  -Xs \
  -P \
  -R
```

The `-R` flag automatically generates `standby.signal` and writes connection parameters to `postgresql.auto.conf`, instructing the instance to start in continuous hot standby recovery mode.

---

## 4. Automated Failover & Consensus via Patroni

For automated leader election, health monitoring, and zero-touch failover, **Patroni** is the recommended orchestrator for NeroNet enterprise clusters.

```
                  +───────────────────────────────+
                  |  DCS Consensus Cluster (etcd) |
                  |  (3 or 5 Node Raft Consensus) |
                  +───────────────┬───────────────+
                                  │
                  +───────────────┴───────────────+
                  │                               │
          +───────▼───────────────+       +───────▼───────────────+
          | Patroni Agent (Node 1)|       | Patroni Agent (Node 2)|
          |  State: Leader (RW)   |       |  State: Standby (RO)  |
          |  PostgreSQL Primary   |       |  PostgreSQL Standby   |
          +───────────────────────+       +───────────────────────+
```

### 4.1 Patroni Configuration Blueprint (`patroni.yml`)

```yaml
scope: neronet-cluster
namespace: /service
name: neronet-node-01

dcs:
  etcd3:
    hosts:
      - etcd-01.internal:2379
      - etcd-02.internal:2379
      - etcd-03.internal:2379
  ttl: 30
  loop_wait: 10
  retry_timeout: 10
  maximum_lag_on_failover: 1048576 # 1MB max lag for promotion

bootstrap:
  dcs:
    ttl: 30
    loop_wait: 10
    retry_timeout: 10
    synchronous_mode: true
    postgresql:
      use_pg_rewind: true
      use_slots: true
      parameters:
        wal_level: replica
        max_wal_senders: 10
        wal_keep_size: 1024MB
        hot_standby: 'on'

postgresql:
  listen: 0.0.0.0:5432
  connect_address: 172.28.0.10:5432
  data_dir: /var/lib/postgresql/data
  authentication:
    replication:
      username: replicator
      password: StrongReplicationPassword2026!
    superuser:
      username: postgres
      password: StrongAdminPassword2026!
```

### 4.2 Failover Sequence & Split-Brain Prevention

1. **Heartbeat Loss:** If the Primary node fails to renew its lease in `etcd` within the TTL (30 seconds), the DCS declares the leader lock expired.
2. **Leader Election:** The standby with the lowest WAL lag acquires the DCS leader lock.
3. **Promotion:** Patroni promotes the elected standby to Primary (`pg_ctl promote`).
4. **Pooler Reroute:** PgBouncer or the L7 load balancer detects the new leader via Patroni's REST health check (`GET http://<host>:8008/primary`) and redirects all write traffic within <3 seconds.
5. **Rewind & Rejoin:** When the old Primary recovers, Patroni runs `pg_rewind` to synchronize any uncommitted WAL segments and re-attaches the node as a Standby replica automatically.

---

## 5. Valkey 7 Clustering & Replication

In production environments, Valkey 7 can be deployed in a **Primary-Replica Sentinel** configuration or **Valkey Cluster Mode**:

- **Valkey Sentinel:** Provides automated master failover with virtual IP or client-side Sentinel discovery.
- **Pub/Sub Clustering:** Valkey automatically broadcasts Pub/Sub messages across all cluster nodes, ensuring that an event published on Node 1 is immediately received by subscribers on Node 2 and Node 3.

---

## 6. Disaster Recovery & Backup Strategy

| Backup Type | Tool | Frequency | Retention | RPO / RTO |
|---|---|---|---|---|
| **Continuous WAL Archiving** | `pgBackRest` / `WAL-G` | Continuous | 30 Days | RPO: < 1 Minute |
| **Daily Full Physical Backup** | `pg_basebackup` / `pgBackRest` | Daily at 02:00 UTC | 90 Days | RTO: < 15 Minutes |
| **Logical Schema & Seed Dump** | `pg_dump` | Weekly | 1 Year | Cold Recovery |

---

## 7. Operational Verification & Health Probe Matrix

To independently verify the High Availability state:

```bash
# 1. Check Primary Node Replication Status
psql -U neronet -d neronet_db -c "
  SELECT client_addr, state, sync_state, sync_priority, 
         pg_wal_lsn_diff(pg_current_wal_lsn(), write_lsn) AS write_lag_bytes,
         pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS replay_lag_bytes
  FROM pg_stat_replication;
"

# 2. Check Standby Node Recovery Status
psql -U neronet -d neronet_db -c "
  SELECT pg_is_in_recovery(), pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn(),
         pg_last_xact_replay_timestamp();
"

# 3. Check Valkey Pub/Sub State
valkey-cli PUBSUB CHANNELS "neronet:*"

# 4. Check API Health Probe (PostgreSQL + Valkey connectivity)
curl -s http://127.0.0.1:8081/api/health | jq .
```
