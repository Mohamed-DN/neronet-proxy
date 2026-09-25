# NeroNet v4 — Guida Amministratore (IT)

## Accesso al Sistema

### Console Web
- **URL**: http://127.0.0.1:8443  (prod: https://your-domain:8443)
- **Utente admin**: `admin`
- **Password**: definita in `.env` → `SOVEREIGN_ADMIN_PASS`

### API REST
- **URL**: http://127.0.0.1:8081
- **Docs**: http://127.0.0.1:8081/api/docs
- **Auth**: POST `/api/auth/login` → Bearer token (JWT, 15min)

### Credenziali di Default (dopo install.sh)
Il file `.env` generato contiene le credenziali. Consultarlo con:
```bash
grep -E 'ADMIN|TOKEN' /opt/neronet/.env
```

---

## Gestione Nodi

### Registrazione automatica
I nodi Go si registrano automaticamente al control plane usando `SOVEREIGN_REGISTRATION_TOKEN`.
Ogni nodo riceve un IP overlay dalla CIDR `100.64.0.0/10` (CGNAT).

### Revoca nodo
```http
DELETE /api/nodes/{node_id}
Authorization: Bearer <token>
```
Oppure dalla Console → Nodi → ⋮ → Revoca

### Quarantena
```http
PATCH /api/nodes/{node_id}
{ "status": "quarantined" }
```

---

## Operazioni Database

### Backup manuale
```bash
podman exec sovereign_proxy_v4_release-postgres-1 \
  pg_dump -U neronet neronet_db | gzip > backup_$(date +%Y%m%d).sql.gz
```

### Restore
```bash
gunzip -c backup_20260925.sql.gz | \
  podman exec -i sovereign_proxy_v4_release-postgres-1 \
  psql -U neronet neronet_db
```

---

## NeroNuke (Crypto-Shredding)

**ATTENZIONE**: operazione irreversibile. Richiede dual-auth (4 occhi).

1. Operatore A: Console → NeroNuke → Seleziona target → Inizia
2. Operatore B: riceve notifica → Approva
3. Il sistema esegue crypto-shredding: le chiavi crittografiche vengono distrutte, i dati diventano irrecuperabili

**Audit trail**: ogni operazione NeroNuke è firmata nell'audit log (HMAC-SHA256, immutabile).

---

## Ruoli RBAC

| Ruolo     | Permessi |
|-----------|----------|
| `admin`   | Tutto, incluso NeroNuke e gestione utenti |
| `operator`| Gestione nodi, ACL, topologia |
| `auditor` | Solo lettura, esportazione audit log |

---

## Troubleshooting

| Problema | Causa | Soluzione |
|----------|-------|-----------|
| Nodi non si registrano | Schema contratto mancante | Ricostruire l''immagine backend |
| PG18 non parte | Volume formato vecchio | `podman compose down -v && up` |
| Frontend 502 | Backend non healthy | Attendere healthcheck, controllare logs |
| Login fallito | Password errata / JWT scaduto | Reset password via env, riavvio |
