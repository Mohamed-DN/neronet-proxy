# NeroNet v4.0.0-rc1 - Release Candidate Checklist (WP-605)

## Gate G6 - Go/No-Go Final Certification

### A. Qualità del Codice
- [x] Zero data race (go test -race ./... su tutti i package Go)
- [x] gofmt e go vet puliti (verificato su Linux daemon e Windows native client)
- [x] Prettier + ESLint verde su tutta la console UI
- [x] TypeScript senza errori di tipo (build Vite completa)
- [x] Nessun TODO/FIXME bloccante in path critici

### B. Test & Validazione
- [x] Unit test Go: 100% pass (WP-501 fuzzing verde)
- [x] Unit test backend Node.js: 100% pass
- [x] Unit test frontend Vitest: 100% pass
- [x] Test E2E Playwright: 100% pass (WP-411)
- [x] Axe a11y: zero violazioni critiche/gravi (WP-410)
- [x] Test carico k6 100k nodi: entro budget di latenza (WP-502)
- [x] Test sicurezza ZAP: zero finding HIGH (WP-503)
- [x] Test upgrade N-1 -> N: passato con verifica integrità (WP-505)

### C. Sicurezza & Supply Chain
- [x] SBOM generato (CycloneDX + SPDX) - WP-504
- [x] Immagine firmata con cosign (keyless) - WP-504
- [x] SLSA v1.0 Build Level 3 provenance - WP-504
- [x] Build riproducibile (2 build indipendenti, hash identico) - WP-504
- [x] SECURITY.md e .well-known/security.txt - WP-603
- [x] Nessun segreto nel codice/immagine (gitleaks pulito)
- [x] Dipendenze verificate e conformi

### D. Conformità Normativa (Compliance)
- [x] Mapping DORA/NIS2/GDPR/AgID documentato - WP-603
- [x] Dichiarazione di accessibilità WCAG 2.1 AA - WP-603
- [x] Audit trail HMAC-SHA256 con catena crittografica non ripudiabile - WP-301
- [x] NeroNuke crypto-shredding con protocollo DoD 5220.22-M - WP-302

### E. Installazione, Deploy & Mesh Operativa
- [x] install.sh one-command Linux/macOS - WP-601
- [x] Chart Helm enterprise testato su Kubernetes/Kind - WP-601
- [x] Native Windows WireGuard+Wintun daemon e service - WP-602
- [x] Flotta Podman attiva: 19 container running (13 nodi geografici IT/ES/UK/DE/FR/US/JP/CH/SE, 2 DERP relay, 4 core)
- [x] Topologia 2D a ragnatela elastica con fisica vettoriale, routing per link (Direct/DERP/OpenVPN/Onion) e isolamento bilaterale

### F. Documentazione
- [x] Guida Amministratore IT/EN - WP-604
- [x] Runbook operativi: Incident Response e Disaster Recovery IT/EN - WP-604
- [x] API Reference e contratti JSON Schema v4 (16/16) - WP-102
- [x] HANDOVER master aggiornato a Gate G6

### G. Credenziali di Accesso e Configurazione
| Servizio       | Endpoint / URL                | Utente | Password               | Note |
|----------------|-------------------------------|--------|------------------------|------|
| Console Web    | http://127.0.0.1:8443         | admin  | Admin@NeroNet2026!     | Single-page App React + Nginx |
| API REST       | http://127.0.0.1:8081         | admin  | Admin@NeroNet2026!     | JWT Bearer Token |
| API Health     | http://127.0.0.1:8081/api/health | -   | (nessuna auth)         | Monitoraggio / Liveness |
| DERP EU Relay  | http://127.0.0.1:8444         | -      | (TLS + Decoy Nginx)    | Fallback Relay Europa (STUN 3478) |
| DERP US Relay  | http://127.0.0.1:8445         | -      | (TLS + Decoy Nginx)    | Fallback Relay USA (STUN 3479) |

**Token di Registrazione Mesh**: 136022859b2f4a7c28e07dbfa88ff35893c116f20d49d223d4c707bdac3959bf

### H. Esito Gate G6: Go / No-Go
| Requisito di Rilascio | Criterio Minimo di Accettazione | Esito Effettivo | Valutazione |
|-----------------------|---------------------------------|-----------------|-------------|
| Sicurezza Applicativa | Zero vulnerabilità HIGH/CRITICAL (ZAP) | 0 High, 0 Critical | **GO** |
| Integrità Supply Chain | Build riproducibile verificata | Bit-for-bit verified | **GO** |
| Resilienza Flotta | Container core e nodi mesh operativi | 19/19 healthy (13 client mesh) | **GO** |
| Standard Contratti | Schema JSON validati | 16/16 contratti attivi | **GO** |
| Regolamentazione | DORA, NIS2, GDPR, AgID mappati | 100% documentato | **GO** |
| Esperienza Utente | Topologia 2D elastica & selettore trasporto | Reattivo con onda cursore | **GO** |

**DECISIONE FINALE**: ✅ **GO** - NeroNet v4.0.0-rc1 è formalmente approvato per il rilascio Candidate & General Availability.
