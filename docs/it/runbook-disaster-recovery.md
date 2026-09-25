# Runbook Operativo: Disaster Recovery e Ripristino Emergenze (IT)

## Obiettivi di Continuità Operativa (RPO e RTO)
- **RPO (Recovery Point Objective)**: <= 60 secondi (replica streaming WAL verso nodo secondario)
- **RTO (Recovery Time Objective)**: <= 5 secondi (failover automatico Patroni con quorum Raft)

## Procedura 1: Guasto del Nodo Primario PostgreSQL
1. Patroni rileva l'assenza di heartbeat al superamento del lease (10s).
2. Il nodo secondario più aggiornato (LSN maggiore) viene promosso automaticamente a leader.
3. Il pooler HAProxy/PgBouncer sulla porta 5432 commuta il traffico di scrittura in trasparenza.
4. Controllo dello stato cluster:
   `ash
   patronictl -c /etc/patroni/patroni.yml topology
   `

## Procedura 2: Perdita Totale del Sito Primario (Cold DR)
1. Distribuzione dei container nel sito di disaster recovery tramite Helm / install.sh.
2. Ripristino del database dal backup cifrato pgBackRest su object storage:
   `ash
   pgbackrest --stanza=neronet --delta restore
   `
3. Avvio del cluster Patroni in modalità standby promotion.
4. Aggiornamento dei record GeoDNS per instradare console e relay DERP sul nuovo sito.
5. I client WireGuard si riconnettono automaticamente tramite risoluzione DNS dinamica in < 15 secondi.
