# Backup e ripristino

Il profilo opzionale `backup` esegue backup restic cifrati ogni sei ore. Un set
completo contiene dump PostgreSQL custom, manifest SHA-256 canonico e file backend
(identità di federazione e chiave di firma checkpoint audit). Ogni dump viene
realmente ripristinato in PostgreSQL privato temporaneo prima dell'accettazione.
Il volume `backup_work` deve avere spazio per dump e database ripristinato.

Da Git Bash su Windows o shell POSIX su Linux, usate la `.env` dell'installazione
e un nome progetto esplicito. Aggiungete la password restic a una `.env` precedente:

```sh
sh scripts/dev/gen-env.sh --append-missing
export COMPOSE_PROJECT_NAME=neronet-produzione
sh scripts/dev/stack.sh backup
podman compose --profile backup exec -T backup neronet-backup status
podman compose --profile backup exec -T backup neronet-backup sets
sh scripts/ops/restore.sh --verify --repo primary --set latest
```

`--verify` ripristina in un database temporaneo distinto, confronta tutte le tabelle
public, schema e sequenze con il manifest dello snapshot, e confronta le chiavi
backend salvate con quelle correnti. Non modifica il database live. Una chiave
corrente diversa fa fallire la verifica e richiede un controllo. Per il restore
live fermate gli scrittori e scegliete un set completo. `--replace` sostituisce
database e dati backend del progetto; gli script rifiutano il progetto `neronet`.

```sh
podman compose --profile backup stop backend backup
sh scripts/ops/restore.sh --repo secondary --set IL_VOSTRO_SET --replace
podman compose start backend
podman compose restart frontend
```

Se fallisce, lasciate gli scrittori fermi, controllate errore, repository, set e
segreti dell'installazione; riprovate un set valido. Schema e dati devono coincidere
prima del riavvio. Il dump PostgreSQL online è transazionalmente coerente; i file
backend sono uno snapshot separato. Fermate scrittori e rotazione chiavi per un
punto di recupero coordinato. Ruoli/grant del cluster, schemi diversi da public e
volumi identità dei nodi sono fuori da questo backup. Recuperate le identità sui
rispettivi nodi.

Conservate `.env` in un archivio di recupero separato con accesso controllato: restic
non la copia. Preservate password restic/secondaria, credenziali PostgreSQL, segreti
JWT/refresh, `SOVEREIGN_AUDIT_HMAC_SECRET`, `SOVEREIGN_SHRED_KEK_SECRET` e KEK
precedente, credenziali enrolment, chiavi TLS e CA. Senza KEK i segreti cifrati non
si aprono; senza HMAC e chiave checkpoint il ledger non si verifica interamente.
La perdita della password restic rende il repository illeggibile.

`backup_repo` vive sullo stesso host. Configurate `NERONET_BACKUP_SECONDARY` su una
destinazione realmente separata (URL restic S3, SFTP o REST HTTPS), con credenziali.
Esempio S3: `s3:https://storage.example/bucket/neronet`, `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION`. Per SFTP montate chiave privata e
known_hosts verificato in `/home/neronet/.ssh` tramite override compose. Ricreate
`backup` dopo una modifica delle variabili. Una copia fallita fa fallire ciclo e
health check; gli ID repository devono essere diversi. La destinazione vuota è
locale soltanto. `/secondary` o un altro volume locale non protegge da perdita host/disco.

Default: intervallo 6h; ultimi 4 snapshot, 7 giornalieri, 4 settimanali, 6 mensili
per componente; integrity check primario sul 5% dei pack. Configurate
`NERONET_BACKUP_INTERVAL`, `NERONET_BACKUP_KEEP_*`, `NERONET_BACKUP_CHECK_SUBSET`.
La retention esegue prune; usate `NERONET_BACKUP_SECONDARY_PRUNE=false` se la gestisce
un altro operatore. Dopo crypto-shredding, i vecchi backup restano leggibili finché
esistono vecchia KEK e password restic. Scadenza backup e ritiro KEK sono operazioni
distinte.

Eseguite il drill distruttivo soltanto su uno stack nuovo usa e getta con `.env`
generata per il test:

```sh
export COMPOSE_PROJECT_NAME=neronet-backup-drill NERONET_PORT_OFFSET=400
export NERONET_NODE_SERVICES='relay-de client-it'
sh scripts/dev/stack.sh up
sh scripts/dev/stack.sh nodes derp-eu relay-de client-it
sh scripts/dev/smoke.sh 2 180
sh scripts/ops/backup-drill.sh --destroy-test-data --secondary-test
NERONET_FLEET_FILE=docker/backup/docker-compose.test.yml sh scripts/dev/stack.sh down -v
```

Il drill controlla progetto e volume esatto, verifica le copie locale e REST,
elimina solo il database di test e i suoi dati backend, poi ripristina da REST.
Richiede manifest completo identico prima del riavvio, apre un segreto cifrato,
verifica HMAC/checkpoint audit, misura TCP attraverso due veri nodi netstack e
richiede zero nuovi enrolment. Il server REST è sullo stesso host: è una prova del
backend remoto, non un deployment offsite né una prova di perdita completa host.
Verificate separatamente destinazione offsite e segreti di recupero. L'API
recovery-proof richiede DB target distinto e contenuti fermi identici; il certificato
da solo non prova che sia avvenuto un backup/restore offsite. Il drill non certifica
cancellazione dei backup precedenti dopo shredding.
