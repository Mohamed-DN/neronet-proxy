# Runbook: disaster recovery (EN)

This runbook covers what a NeroNet deployment can recover from today: one host, one
PostgreSQL, restored from the encrypted restic backup. It makes no RPO or RTO
promise, because neither has been measured on a real deployment.

## What exists and what does not

| Capability | State |
|---|---|
| Encrypted restic backup every 6 h (`backup` profile), each dump test-restored before acceptance | Available, see [Backup and restore](backup-restore.md) |
| Verified restore (`scripts/ops/restore.sh --verify`) and live restore (`--replace`) | Available |
| Destructive restore drill (`scripts/ops/backup-drill.sh`), run in CI on a disposable stack | Available; the REST copy it uses is on the same host |
| Offsite copy (`NERONET_BACKUP_SECONDARY`) | Supported by the backup service; **no real offsite destination has been demonstrated** |
| Automatic database failover (Patroni/etcd) | **Not available.** `docker/docker-compose.ha.yml` is an untested draft; the HA gates H0–H5 are open |
| pgBackRest, multi-region restore, Anycast/GeoDNS | **Not part of NeroNet.** None of them is configured or tested |

The data loss window is bounded by the backup interval (`NERONET_BACKUP_INTERVAL`,
6 h by default) as configured, not as measured. The time to recover depends on the
dump size and the host; time your own drill.

## Procedure: the database or the host is lost

1. Stop writers on the damaged deployment if it still runs:
   `podman compose --profile backup stop backend backup`.
2. On the same host, or a new one with the deployment's `.env` restored from its
   separate recovery store (restic does not hold it), bring the stack up with the
   same project name and secrets.
3. List complete sets and pick one:
   `podman compose --profile backup exec -T backup neronet-backup sets`.
4. Restore it: `sh scripts/ops/restore.sh --repo primary --set <SET> --replace`
   (`--repo secondary` when the primary repository was on the lost host).
5. Start the backend and restart the console:
   `podman compose start backend` and `podman compose restart frontend`.
6. Check before declaring recovery: `/api/health`, the audit ledger verification, and
   real traffic between two nodes. Node identities live on the nodes and are not in
   the backup; a node that lost its own volume enrols again.

Full commands, what the restore compares and what it leaves out are in
[Backup and restore](backup-restore.md). The restore scripts need an explicit
`COMPOSE_PROJECT_NAME` and always refuse the project name `neronet`.
