# Runbook: Incident Response & Threat Containment (EN)

## Severity 1: Compromised Node or Key Leak

### Step 1: Immediate Node Quarantine
Execute via API or administrative console:
`ash
curl -X PATCH http://127.0.0.1:8081/api/nodes/<NODE_ID> \
  -H Authorization: Bearer  \
  -H Content-Type: application/json \
  -d '{status:quarantined}'
`
This triggers an instant Netmap sync revoking the peer key across all running WireGuard interfaces in < 500ms.

### Step 2: Mesh Visibility Severance
If lateral movement is suspected, isolate the target peer from all neighboring peers:
`ash
curl -X POST http://127.0.0.1:8081/api/stats/topology/link \
  -H Authorization: Bearer  \
  -H Content-Type: application/json \
  -d '{sourceNode:<NODE_ID>,targetNode:*,visibility:false}'
`

### Step 3: Forensic Log Extraction
Extract tamper-evident HMAC audit trails:
`ash
curl -G http://127.0.0.1:8081/api/audit/logs \
  -H Authorization: Bearer  \
  --data-urlencode node_id=<NODE_ID> \
  -o incident_audit_<NODE_ID>.json
`
Verify audit signature integrity:
`ash
node -e require('./console/backend/lib/audit').verifyChain('incident_audit_<NODE_ID>.json')
`

### Step 4: Revocation & Key Invalidation
Once forensics conclude:
`ash
curl -X DELETE http://127.0.0.1:8081/api/nodes/<NODE_ID> \
  -H Authorization: Bearer 
`
