# Runbook: Disaster Recovery & High Availability Failover (EN)

## RPO & RTO Objectives
- **Recovery Point Objective (RPO)**: <= 60 seconds (WAL streaming replication to secondary standby)
- **Recovery Time Objective (RTO)**: <= 5 seconds (Automated Patroni Raft failover)

## Procedure 1: Primary Database Node Failure
1. Patroni automatically detects missed heartbeats (> 10s lease expiration).
2. The healthiest standby node with highest LSN is promoted to primary.
3. Client connections via HAProxy/PgBouncer port 5432 are transparently routed to the new leader.
4. Verify cluster health:
   `ash
   patronictl -c /etc/patroni/patroni.yml topology
   `

## Procedure 2: Complete Datacenter Outage (Cold DR Restoration)
1. Provision infrastructure in secondary region via Terraform / Helm chart.
2. Restore database from latest S3/pgBackRest snapshot:
   `ash
   pgbackrest --stanza=neronet --delta restore
   `
3. Start Patroni cluster in standby mode.
4. Update Anycast/GeoDNS records pointing to new console and DERP endpoints.
5. All active WireGuard peers reconnect automatically via dynamic DNS re-resolution within 15 seconds.
