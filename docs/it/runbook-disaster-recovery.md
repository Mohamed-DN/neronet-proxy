# Runbook: disaster recovery (IT)

Questo runbook copre ciò da cui un'installazione NeroNet sa riprendersi oggi: un solo
host, un solo PostgreSQL, ripristinato dal backup restic cifrato. Non promette RPO né
RTO, perché nessuno dei due è stato misurato su un'installazione reale.

## Cosa esiste e cosa no

| Capacità | Stato |
|---|---|
| Backup restic cifrato ogni 6 h (profilo `backup`), ogni dump ripristinato in prova prima di essere accettato | Disponibile, vedi [Backup e ripristino](backup-restore.md) |
| Ripristino verificato (`scripts/ops/restore.sh --verify`) e ripristino reale (`--replace`) | Disponibile |
| Esercitazione distruttiva (`scripts/ops/backup-drill.sh`), eseguita in CI su uno stack usa e getta | Disponibile; la copia REST che usa è sullo stesso host |
| Copia offsite (`NERONET_BACKUP_SECONDARY`) | Supportata dal servizio di backup; **nessuna destinazione offsite reale è stata dimostrata** |
| Failover automatico del database (Patroni/etcd) | **Non disponibile.** `docker/docker-compose.ha.yml` è una bozza mai provata; i gate HA H0–H5 sono aperti |
| pgBackRest, ripristino multi-regione, Anycast/GeoDNS | **Non fanno parte di NeroNet.** Nessuno è configurato o provato |

La finestra di perdita dati è limitata dall'intervallo di backup
(`NERONET_BACKUP_INTERVAL`, 6 h di default) come configurato, non come misurato. Il
tempo di ripristino dipende dalla dimensione del dump e dall'host: misura il tuo.

## Procedura: si perde il database o l'host

1. Ferma chi scrive sull'installazione danneggiata, se è ancora in piedi:
   `podman compose --profile backup stop backend backup`.
2. Sullo stesso host, o su uno nuovo con il `.env` dell'installazione recuperato dal
   suo archivio separato (restic non lo contiene), avvia lo stack con lo stesso nome
   di progetto e gli stessi segreti.
3. Elenca i set completi e scegline uno:
   `podman compose --profile backup exec -T backup neronet-backup sets`.
4. Ripristinalo: `sh scripts/ops/restore.sh --repo primary --set <SET> --replace`
   (`--repo secondary` se il repository primario era sull'host perso).
5. Avvia il backend e riavvia la console:
   `podman compose start backend` e `podman compose restart frontend`.
6. Verifica prima di dichiarare il ripristino: `/api/health`, la verifica del registro
   di audit e traffico reale tra due nodi. Le identità dei nodi stanno sui nodi e non
   sono nel backup; un nodo che ha perso il proprio volume si registra di nuovo.

Comandi completi, cosa confronta il ripristino e cosa esclude sono in
[Backup e ripristino](backup-restore.md). Gli script di ripristino richiedono un
`COMPOSE_PROJECT_NAME` esplicito e rifiutano sempre il nome di progetto `neronet`.
