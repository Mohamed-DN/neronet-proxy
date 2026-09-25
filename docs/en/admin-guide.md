# NeroNet v4 - Administrator Guide (EN)

## System Access

### Web Console
- **URL**: http://127.0.0.1:8443 (Production: https://your-domain:8443)
- **Default Admin User**: dmin
- **Default Password**: configured in .env via SOVEREIGN_ADMIN_PASS

### REST API
- **URL**: http://127.0.0.1:8081
- **OpenAPI Documentation**: http://127.0.0.1:8081/api/docs
- **Authentication**: POST /api/auth/login -> Bearer JWT token (15 min lifespan, rotation supported)

### Environment Credentials
The deployment generates configuration in /opt/neronet/.env. Inspect sensitive variables with:
`ash
grep -E 'ADMIN|TOKEN|SECRET' /opt/neronet/.env
`

---

## Node and Fleet Management

### Automated Node Registration
Go client nodes connect and register automatically using SOVEREIGN_REGISTRATION_TOKEN.
Each peer is assigned an overlay IP from the CGNAT block 100.64.0.0/10.

### Node Revocation & Quarantine
- **Revoke Node**:
  `http
  DELETE /api/nodes/{node_id}
  Authorization: Bearer <token>
  `
  Immediately invalidates the WireGuard peer pubkey across the entire mesh via synchronized Netmap push.
- **Quarantine Node**:
  `http
  PATCH /api/nodes/{node_id}
  { status: quarantined }
  `
  Isolates the target node, injecting dynamic drop rules across all mesh firewalls.

---

## Topology & Dynamic Link Configuration

### 2D Physics Mesh Ragnatela
The Web Console features a real-time 2D physics graph displaying peer connections.
- **Direct WireGuard**: Low latency peer-to-peer kernel/userspace UDP tunnel.
- **DERP Relay**: Encapsulated TLS fallback via regional relays (derp-eu, derp-us) when symmetric NAT prevents direct hole-punching.
- **OpenVPN Stealth Mode**: Obfuscated TCP/TLS 443 transport for restrictive enterprise/banking firewalls.
- **Onion Multi-Hop**: Multi-layered encrypted circuit routing for high-assurance anonymity.
- **Device Visibility Isolation**: Select two nodes to revoke bilateral visibility without removing peers from the global cluster.

---

## High Availability & Backups

### PostgreSQL HA with Patroni
Production deployments run three Patroni nodes backed by Raft/etcd consensus. Failover occurs within 3-5 seconds.
`ash
patronictl -c /etc/patroni/patroni.yml topology
`

### Automated Physical Backups (pgBackRest)
Daily full and hourly incremental backups are stored in S3/MinIO compatible object stores with AES-256 GCM encryption.
`ash
pgbackrest --stanza=neronet backup
pgbackrest --stanza=neronet check
`
