# NeroNet v4: guida amministratore

Le operazioni di tutti i giorni, con gli endpoint come esistono. Il manuale
([`docs/HANDBOOK.md`](../HANDBOOK.md), in inglese) spiega come funziona ogni parte;
questa pagina è la versione breve.

## Accesso

| Cosa | Dove |
|---|---|
| Console | `https://127.0.0.1:8443` nello stack compose, solo TLS. Lo stack di sviluppo usa una CA generata da `scripts/dev/gen-certs.sh`; un'installazione monta il proprio certificato, chiave e CA con gli stessi nomi di secret compose (`console_tls_cert`, `console_tls_key`, `control_plane_ca`) |
| API | `http://127.0.0.1:8081`, anche sotto `/api` attraverso la console. Il contratto è [`api/openapi.yaml`](../../api/openapi.yaml); il server non pubblica documentazione interattiva |
| Primo account | `admin`, password da `SOVEREIGN_ADMIN_PASS` nel `.env` |
| Accesso | `POST /api/auth/login`. Il token di accesso dura 15 minuti; il refresh token è un cookie HttpOnly |

Con `SOVEREIGN_MFA_MANDATORY=admins` (il default in produzione) il super-admin di
piattaforma e ogni owner e admin di organizzazione accedono con un codice TOTP. Un
account senza app di autenticazione viene guidato all'attivazione al primo accesso, e
vede i codici di recupero una volta sola.

## Nodi

### Iscrivere un nodo

Il nodo dimostra di possedere la propria chiave privata a ogni registrazione (ADR 0017).
Una chiave nuova è autorizzata da:

- una pre-auth key creata dalla console (`POST /api/preauth-keys`), data al nodo come
  `SOVEREIGN_ENROLMENT_KEY` (`nnk1:<chiave>:<impronta>`, che fissa anche la chiave del
  control plane); quelle monouso si consumano alla prima iscrizione;
- il token di flotta `SOVEREIGN_REGISTRATION_TOKEN`, per le flotte automatiche.

Un nodo già iscritto si registra di nuovo con la sola chiave. Ogni nodo riceve un
indirizzo overlay da `100.64.0.0/10` e una propria credenziale per tutto il resto.

### Quarantena e revoca

| Azione | Richiesta | Effetto |
|---|---|---|
| Quarantena | `POST /api/nodes/{id}/action` `{"action":"quarantine","reason":"..."}` | Il nodo esce dai peer di tutti entro un heartbeat, e la sua credenziale smette di funzionare |
| Fine quarantena | `POST /api/nodes/{id}/action` `{"action":"lift_quarantine"}` | Rientra |
| Revoca | `DELETE /api/nodes/{id}` | La chiave è revocata e comunicata a tutti i nodi; il nodo non può registrarsi di nuovo con essa |

`scripts/dev/scenarios/overlay.sh quarantine` e `revoke` le mostrano su uno stack
avviato, con traffico vero.

## Policy di accesso

I nodi di un'organizzazione si collegano solo fra loro. Dentro l'organizzazione decidono
le regole ACL (`/api/acl/rules`), vince la prima che corrisponde; senza regole decide la
`default_policy` dell'organizzazione (`open` o `deny`). Una modifica arriva ai nodi entro
un heartbeat, 15 secondi di default.

## Trasporti

L'overlay è WireGuard (wireguard-go, in userspace di default). La chiave pre-condivisa di
ogni coppia ruota ogni due minuti; è crittografia classica, non post-quantum. I nodi
usano i relay DERP solo in ingresso: non c'è ancora il ripiego via relay per una coppia
che non si raggiunge direttamente. L'offuscamento stile AmneziaWG esiste nel codice e il
nodo non lo attiva. Non esistono trasporti OpenVPN o VLESS.

## Disponibilità e backup

Lo stack standard ha un'istanza per servizio. `docker/docker-compose.ha.yml` descrive un
cluster Patroni a tre nodi con HAProxy e due istanze del control plane; non è mai stato
provato come cluster, e Valkey vi è un'istanza singola. I job periodici girano solo sul
leader eletto.

Il servizio restic opzionale esegue backup cifrati ogni sei ore e li copia nel
repository secondario configurato. La guida [backup e ripristino](backup-restore.md)
descrive verifica, segreti di recupero, retention e drill distruttivo di test.
