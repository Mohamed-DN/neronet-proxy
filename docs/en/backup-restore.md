# Backup and restore

The optional `backup` profile takes an encrypted restic backup every six hours.
A complete set holds a custom PostgreSQL dump, its canonical SHA-256 manifest,
and backend files (federation identity and audit checkpoint signing key). Each
dump is actually restored in private temporary PostgreSQL before acceptance.
Reserve space for a dump and restored database in the `backup_work` volume.

Use Git Bash on Windows or a POSIX shell on Linux, the deployment's existing
`.env`, and an explicit project name. An older `.env` needs the restic password:

```sh
sh scripts/dev/gen-env.sh --append-missing
export COMPOSE_PROJECT_NAME=neronet-production
sh scripts/dev/stack.sh backup
podman compose --profile backup exec -T backup neronet-backup status
podman compose --profile backup exec -T backup neronet-backup sets
sh scripts/ops/restore.sh --verify --repo primary --set latest
```

`--verify` restores into a separate temporary database, compares all public tables,
schema and sequences with the snapshot manifest, and compares saved backend key
files with current files. It leaves the live database intact. Different current
key files fail verification and require investigation. For live recovery, stop
writers and select a complete set. `--replace` replaces that project's database
and backend data; scripts refuse the protected project `neronet`.

```sh
podman compose --profile backup stop backend backup
sh scripts/ops/restore.sh --repo secondary --set YOUR_SET --replace
podman compose start backend
podman compose restart frontend
```

On failure, leave writers stopped, check the error, repository, set and deployment
secrets, and retry a known good set. Schema/data must match before writers restart.
Online PostgreSQL dumps are transactionally consistent; backend files are a separate
snapshot. Freeze writers and key rotation for a coordinated recovery point. Cluster
roles/grants, application schemas other than public, and node identity volumes are
outside this backup. Recover node identities on their respective nodes.

Keep `.env` in a separate access-controlled recovery store. Restic does not copy it.
Preserve restic/secondary passwords, PostgreSQL credentials, JWT/refresh secrets,
`SOVEREIGN_AUDIT_HMAC_SECRET`, `SOVEREIGN_SHRED_KEK_SECRET` and any previous KEK,
enrolment credentials, TLS keys and CA. Without the KEK, sealed secrets cannot be
opened; without audit HMAC/checkpoint keys, the ledger cannot be fully verified.
Losing the restic password makes the repository unreadable.

`backup_repo` is on this host. Configure a genuinely separate destination with
`NERONET_BACKUP_SECONDARY` (restic S3, SFTP or HTTPS REST URL) and its credentials.
S3 example: `s3:https://storage.example/bucket/neronet` with `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION`. For SFTP, mount a private key and
pinned known_hosts into `/home/neronet/.ssh` through a deployment compose override.
Recreate `backup` after environment changes. A failed copy fails the cycle and
health check; repository IDs must differ. An empty secondary is local-only.
`/secondary` or another local volume does not protect against host/disk loss.

Defaults: interval 6h; last 4, daily 7, weekly 4, monthly 6 snapshots per component;
primary integrity check reads 5% of packs. Configure `NERONET_BACKUP_INTERVAL`,
`NERONET_BACKUP_KEEP_*`, `NERONET_BACKUP_CHECK_SUBSET`. Retention prunes; set
`NERONET_BACKUP_SECONDARY_PRUNE=false` if another operator manages it. After
crypto-shredding, old backups remain readable while old KEK and restic password
exist. Backup expiry and KEK retirement are separate operations.

Run the destructive acceptance drill only on a new disposable stack with its own
generated `.env`:

```sh
export COMPOSE_PROJECT_NAME=neronet-backup-drill NERONET_PORT_OFFSET=400
export NERONET_NODE_SERVICES='relay-de client-it'
sh scripts/dev/stack.sh up
sh scripts/dev/stack.sh nodes derp-eu relay-de client-it
sh scripts/dev/smoke.sh 2 180
sh scripts/ops/backup-drill.sh --destroy-test-data --secondary-test
NERONET_FLEET_FILE=docker/backup/docker-compose.test.yml sh scripts/dev/stack.sh down -v
```

The drill checks project labels and the exact backend volume, verifies local and
controlled REST copies, drops only its test database and erases its backend data,
then restores from REST. It requires the full pre/post manifest to match before
writers restart, opens a sealed secret, verifies audit HMAC/checkpoints, measures
TCP through two real netstack nodes, and requires zero new re-enrolments. The REST
server is on this host: this tests the remote backend, not an offsite deployment
or host-loss recovery. Test the actual offsite destination and recovery secrets
separately. The recovery-proof API requires a distinct target DB with quiescent
matching contents; its certificate alone does not prove a backup/offsite restore
occurred. This drill does not certify erasure of older backups after shredding.
