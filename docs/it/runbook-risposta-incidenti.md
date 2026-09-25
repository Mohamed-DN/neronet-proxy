# Runbook Operativo: Risposta agli Incidenti di Sicurezza (IT)

## Severità 1: Compromissione Chiave o Nodo Violato

### Fase 1: Isolamento e Quarantena Immediata
Eseguire tramite console di comando o API di emergenza:
`ash
curl -X PATCH http://127.0.0.1:8081/api/nodes/<NODE_ID> \
  -H Authorization: Bearer  \
  -H Content-Type: application/json \
  -d '{status:quarantined}'
`
L'azione propaga istantaneamente l'aggiornamento Netmap revocando l'accesso WireGuard su tutti i nodi della mesh in meno di 500ms.

### Fase 2: Recisione Visibilità Mesh
Per bloccare qualsiasi tentativo di movimento laterale verso nodi critici o dati riservati:
`ash
curl -X POST http://127.0.0.1:8081/api/stats/topology/link \
  -H Authorization: Bearer  \
  -H Content-Type: application/json \
  -d '{sourceNode:<NODE_ID>,targetNode:*,visibility:false}'
`

### Fase 3: Estrazione Forense Audit Log Firmato
Scaricare i log certificati con catena HMAC:
`ash
curl -G http://127.0.0.1:8081/api/audit/logs \
  -H Authorization: Bearer  \
  --data-urlencode node_id=<NODE_ID> \
  -o incidente_audit_<NODE_ID>.json
`
Verifica dell'integrità della catena di firma:
`ash
node -e require('./console/backend/lib/audit').verifyChain('incidente_audit_<NODE_ID>.json')
`

### Fase 4: Revoca Permanente e Bonifica
Completata l'indagine forense:
`ash
curl -X DELETE http://127.0.0.1:8081/api/nodes/<NODE_ID> \
  -H Authorization: Bearer 
`
