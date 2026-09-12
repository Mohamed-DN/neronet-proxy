# Piano esecutivo NeroNet

Guida operativa per portare NeroNet da prototipo funzionante a prodotto di produzione.
Ogni numero citato qui è misurato sullo stack in esecuzione, non stimato.

Stato al 12 settembre 2026. Fase 0 completata e pubblicata (`71cb108`).

---

## 1. Alta disponibilità senza split-brain

Questa sezione viene prima perché è il vincolo che condiziona tutto il resto.

### 1.1 Cos'è davvero lo split-brain

Lo split-brain non è "due server attivi". È **due server che accettano scritture
credendo entrambi di essere l'autorità**, mentre la rete fra loro è partita. Quando
la partizione si risolve, esistono due storie divergenti degli stessi dati e nessun
criterio automatico per sceglierne una.

In Oracle RAC il problema è affrontato con voting disk e fencing: i nodi votano
attraverso un supporto condiviso, chi perde il quorum viene **espulso a forza**
(STONITH — shoot the other node in the head) prima di poter scrivere altro. La
lezione che conta non è il meccanismo, è il principio: *non basta accorgersi di
avere perso il quorum, bisogna essere resi incapaci di scrivere.*

### 1.2 La trappola da evitare

"Master-master" su PostgreSQL — BDR, Bucardo, repliche bidirezionali — sposta il
problema, non lo risolve. Trasforma lo split-brain in **risoluzione dei conflitti**,
che per dati di rete significa domande senza risposta giusta: due control plane
assegnano lo stesso indirizzo overlay a due nodi diversi, quale vince? Un nodo è
messo in quarantena da una parte e riabilitato dall'altra, quale stato è vero?

Non si debuggano quei conflitti. Si evitano.

### 1.3 L'architettura corretta

Il principio è separare **chi serve le richieste** da **chi detiene la verità**.

```
        ┌──────────┐  ┌──────────┐  ┌──────────┐
        │ control  │  │ control  │  │ control  │   senza stato locale
        │ plane 1  │  │ plane 2  │  │ plane 3  │   tutte attive
        └────┬─────┘  └────┬─────┘  └────┬─────┘
             └─────────────┼─────────────┘
                           │
                  ┌────────┴────────┐
                  │  PostgreSQL     │  un solo primario per volta
                  │  primario       │  garantito dal quorum
                  └────────┬────────┘
                           │ replica sincrona
                  ┌────────┴────────┐
                  │  standby ×2     │
                  └─────────────────┘
                           │
              ┌────────────┴────────────┐
              │  etcd ×3 (o ×5)         │  il quorum Raft:
              │  quorum e leader key    │  l'equivalente del voting disk
              └─────────────────────────┘
```

**Tutte le istanze del control plane sono attive e paritarie.** Non c'è un master
delle applicazioni. Ognuna può servire qualsiasi richiesta, perché nessuna tiene
stato in memoria. Questo è il vero "master-master" che serve: non replicazione del
database, ma control plane senza stato locale.

**Un solo primario PostgreSQL alla volta**, e chi lo è viene deciso dal quorum etcd,
non da un heartbeat fra due nodi. Patroni gestisce la promozione.

### 1.4 Le quattro regole che impediscono lo split-brain

1. **Numero dispari di votanti.** 3 tollera una perdita, 5 ne tollera due. Con 4 non
   guadagni niente rispetto a 3 e aumenti la superficie di guasto.

2. **Il quorum vive fuori dal database.** etcd è un cluster Raft: la leader key ha
   un TTL, e un primario che non riesce a rinnovarla **perde il ruolo da solo**,
   anche se non riesce a parlare con nessun altro. È esattamente il voting disk di
   RAC, senza hardware condiviso.

3. **Fencing, non solo demozione.** Patroni demota il primario che perde la leader
   key, ma un processo bloccato può non eseguire la demozione. Serve un watchdog
   (`/dev/watchdog` su Linux) che riavvia la macchina se Patroni smette di dare
   segni di vita. Senza watchdog il fencing è una promessa, non una garanzia.

4. **Mai due data center soli.** Due siti non possono formare un quorum che
   sopravvive alla perdita di uno dei due: chi resta ha 50%, non la maggioranza. Se
   hai due sedi, serve un **terzo testimone** altrove — può essere una VPS minuscola
   che fa solo da votante etcd. È l'errore più comune e il più costoso.

### 1.5 Cosa va spostato fuori dai processi

L'HA funziona solo se le istanze non hanno stato proprio. Oggi:

| Stato | Dove vive ora | Dove deve vivere | Fatto |
|---|---|---|---|
| Allocatore VIP (Node) | scansione tabella + ciclo JS | sequenza PostgreSQL | ✅ `71cb108` |
| Allocatore VIP (Go) | `map` in memoria, riparte da 0 al riavvio | stessa sequenza | ⬜ |
| Registry nodi (Go) | `map` + mutex, istanza singola | PostgreSQL | ⬜ |
| Blacklist token | Valkey | Valkey | ✅ |
| Rate limiting | Valkey | Valkey | ✅ `71cb108` |
| Stato heartbeat | PostgreSQL, 6.667 scritture/s a 100k nodi | Valkey + flush aggregato | ⬜ |
| Broadcast topologia | pub/sub Valkey | Valkey | ✅ |

> **Nota su `pkg/control/vip.go`.** L'allocatore Go tiene `nextOffset` in memoria e
> riparte da zero a ogni riavvio: **riassegna indirizzi già in uso**. È un bug di
> corruzione dati che si manifesta solo al restart, cioè esattamente quando un
> sistema HA deve funzionare meglio. Va affrontato nella Fase 1, non dopo.

### 1.6 Come si verifica

Un'architettura HA non testata è un'architettura HA immaginaria.

- **Kill del primario**: promozione automatica, e nessuna scrittura persa.
- **Partizione di rete** (`iptables DROP` fra i nodi): il primario isolato deve
  smettere di accettare scritture **prima** che ne venga promosso un altro.
- **Primario congelato** (`SIGSTOP` sul processo): il watchdog deve intervenire.
- **Perdita del testimone**: con 3 votanti e uno giù, il cluster continua; con due
  giù, si ferma — e fermarsi è il comportamento *corretto*.

Ogni scenario va eseguito e registrato. Un runbook che nessuno ha mai provato è
documentazione, non resilienza.

---

## 2. Cosa prendere dai competitor

Tutti i progetti citati sono open source. L'approccio è studiarne le soluzioni e
reimplementarle nel nostro modello, rispettando le rispettive licenze.

| Funzione | Riferimento | Sforzo | Beneficio | Verdetto |
|---|---|---|---|---|
| **SSO / OIDC** | NetBird, Headscale | Medio | Sblocca ogni adozione organizzativa | **Prendere subito** |
| **Rosenpass per PQ sul tunnel** | NetBird | Basso | Post-quantum senza scrivere crypto | **Prendere subito** |
| **DERP-style relay fallback** | Tailscale | Medio | Connettività dove il P2P fallisce | **Prendere**, parziale in `pkg/derp` |
| **DNS interno (MagicDNS)** | Tailscale | Medio | I nomi valgono più degli indirizzi | **Prendere** |
| **Linguaggio ACL dichiarativo** | Tailscale (HuJSON) | Medio | Policy versionabili e revisionabili | **Prendere**, adattare |
| **Identità a certificati** | Nebula | Basso | Modello più semplice da verificare | **Studiare** |
| **WireGuard nel kernel** | Netmaker, tutti | Alto | Throughput vicino al nativo | **Valutare** — vedi sotto |
| **Client mobile** | NetBird, Tailscale | Molto alto | Copre metà dei dispositivi reali | **Prendere**, uno solo |
| **Posture check** | NetBird, Tailscale | Basso | Già presente in `pkg/posture` | **Completare** |

### 2.1 La decisione difficile: WireGuard o Noise nostro

Oggi NeroNet ha uno stack Noise scritto in casa. Il 12 settembre vi è stato trovato
un riuso di nonce nell'onion routing che annullava confidenzialità **e** integrità.
Il Noise in `pkg/crypto` è invece corretto. Stessa mano, stessa settimana, esiti
opposti: è la natura della crittografia, non una questione di competenza.

**Raccomandazione: WireGuard come trasporto, Rosenpass per il post-quantum.**

Cosa si guadagna: audit formali già esistenti, prestazioni kernel, e — soprattutto —
la possibilità di dire "il trasporto è WireGuard" invece di "fidatevi del nostro".
Per il pubblico di NeroNet quella frase vale più di qualsiasi benchmark.

Cosa si perde: l'onion routing non è esprimibile in WireGuard puro e resta un layer
sopra. Va bene: è lì che sta la differenziazione, ed è lì che va concentrato
l'audit esterno.

---

## 3. Lo stato reale del livello applicativo

Verificato leggendo il codice, non i documenti.

| Funzione | Cosa promette | Cosa fa davvero |
|---|---|---|
| **NeroDrop** | Trasferimento P2P cifrato, chunk 64 KB, BLAKE3 | `routes/nerodrop.js:68` genera una **stringa SDP finta**. Nessun `RTCPeerConnection` nel frontend. Record in database. |
| **Cloud PC** | Streaming WebRTC Selkies, multi-monitor, USB/IP | Record che puntano a `wss://signal.internal.darknero.com`, host che non esiste. Nessun processo di streaming. |
| **App Bundles** | Provisioning Nextcloud, Immich, Seafile, Guacamole | CRUD su `app_bundles`. Nessuna orchestrazione container. |

Non è codice sbagliato: è **interfaccia senza implementazione**. Il problema è che
la console le presenta come attive, che è lo stesso schema dei dati finti già
rimosso a livello di codice, riproposto a livello di prodotto.

**Decisione da prendere, e va presa esplicitamente:** per ciascuna, o si implementa,
o si marca chiaramente come anteprima nell'interfaccia, o si rimuove. Lasciarle così
costa credibilità ogni volta che qualcuno ci clicca sopra.

Ordine suggerito, per rapporto sforzo/valore:

1. **NeroDrop** — sforzo medio. WebRTC DataChannel fra due browser è terreno noto, e
   la mesh fornisce già il percorso. È la funzione più dimostrabile delle tre.
2. **App Bundles** — sforzo medio-alto ma con `docker compose` già presente. Serve
   isolamento serio (gVisor o MicroVM, già progettato in `BUSINESS_AND_ROADMAP.md`
   § 3.3) prima di eseguire container per conto di utenti.
3. **Cloud PC** — sforzo alto. Selkies-GStreamer con encoding hardware è un progetto
   a sé. Va dopo, o mai, a seconda del pubblico.

---

## 4. Rimozione della monetizzazione

Obiettivo: nessuna funzione a pagamento, nessun tier, nessuna quota.

Da rimuovere:

- Colonna `users.tier` e i valori `cloud_managed` / `managed_cloud` / `hybrid_byos` /
  `free_core`. Un solo tipo di utente.
- `bandwidth_quota_gb`, `max_nodes`, e i controlli di quota in `routes/nodes.js` e
  `routes/apps.js`.
- `app_bundles.tier` (`managed_cloud` / `self_hosted_byos`).
- `BUSINESS_AND_ROADMAP.md` capitolo 6 (matrice abbonamenti, unit economics, Stripe
  e BTCPay, cicli di fatturazione) e § 5.5 (licenze Ed25519).
- Componenti frontend che mostrano tier e quote.

Da conservare:

- `users.role` (super-admin / user). L'autorizzazione non è monetizzazione.
- I limiti tecnici reali: rate limiting, dimensione massima di pagina, pool VIP.
  Sono protezioni dell'infrastruttura, non barriere commerciali.

Migration `007_remove_tiering`, con `DROP COLUMN` sulle colonne dei tier e
aggiornamento dei `CHECK`. La rimozione dallo schema va fatta dopo aver tolto ogni
riferimento nel codice, non prima.

---

## 5. Post-quantum: stato e passi rimanenti

| Livello | Stato | Prossimo passo |
|---|---|---|
| TLS control plane | ✅ Ibrido X25519MLKEM768 (`949e441`) | Due test di guardia già in CI |
| Nginx edge | ✅ `ssl_ecdh_curve` configurato | Richiede OpenSSL 3.5+ |
| Dati a riposo | ✅ ChaCha20-Poly1305 / AES-256 | Nulla: Grover dimezza, 128 bit restano abbondanti |
| Tunnel (KEX) | ⬜ X25519 puro | **Rosenpass via PSK** |
| Onion per hop | ⬜ X25519 puro | Ibrido, dopo l'audit esterno |
| Wrapping chiavi tenant | ⬜ da progettare | KEK da Argon2id, **nessuna chiave pubblica** |
| E2EE lato client | ⬜ da progettare | PQXDH (struttura Signal), non reinventare |
| Firme JWT / identità nodo | ⬜ Ed25519 | Bassa priorità: una firma forgiata nel 2040 non rompe una sessione del 2026 |
| Firme CA interna | ⬜ Ed25519 | Media-alta: chiavi che vivono 10+ anni |

**Regola non negoziabile: solo ibrido, mai PQ puro.** ML-KEM è giovane. Concatenare
il segreto classico e quello post-quantum dentro l'HKDF significa restare protetti
se uno dei due cade. È quello che fanno Chrome, Cloudflare, OpenSSH e Go.

**Trappola sul crypto-shredding:** avvolgere una chiave tenant simmetrica (già
PQ-safe) con X25519 o RSA la rende PQ-vulnerabile. Chi ruba il backup oggi la apre
nel 2040 e il crypto-shredding non è servito a niente.

---

## 6. Le fasi

| Fase | Durata | Contenuto | Stato |
|---|---|---|---|
| **0** | 2–3 sett. | Rate limiting, header di sicurezza, liste limitate, allocazione VIP O(1) | ✅ `71cb108` |
| **1** | 1–2 mesi | Stato fuori dai processi, HA con quorum e fencing, un solo backend database | ⬜ |
| **2** | 2–3 mesi | Rosenpass, audit esterno, build riproducibili, threat model | ⬜ |
| **3** | 3–4 mesi | OIDC, installazione in un comando, un client mobile, DNS interno | ⬜ |
| **4** | continuo | Governance, cadenza di rilascio, policy di sicurezza | ⬜ |

Parallelo a tutte: rimozione della monetizzazione e decisione sul livello
applicativo (§ 3).

---

## 7. Regole del codice

Tre, non trenta. Un formattatore automatico risolve il resto.

### 7.1 Un test esegue il sistema, non ne legge il sorgente

La suite dichiarava 140 test superati e un audit indipendente con verdetto "vittoria
confermata", senza aver intercettato un riuso di nonce che azzerava la crittografia,
una data race, e una backdoor di autenticazione. Il motivo sta in righe come
`assert(ddl.includes('CREATE INDEX ... USING GIST'))`: passano con PostgreSQL mai
avviato.

**Vietate le asserzioni sul testo dei file sorgente come prova di comportamento.**

### 7.2 Riprodurre il difetto prima di correggerlo

Ogni correzione deve partire da una prova che fallisce sul codice esistente. Non
"credo che sia rotto qui": *questo comando produce questo output sbagliato*.

### 7.3 Mai inghiottire un errore prima di un passo irreversibile

Un `catch` che non rilancia, davanti a qualcosa di irreversibile, è un bug per
costruzione. La migration 004 catturava il fallimento della copia delle coordinate
con un avviso in un log e poi droppava la colonna: 46 coordinate distrutte. È lo
stesso schema del bridge che rispondeva 200 su otto rotture diverse.

### 7.4 In CI

- `go test -race` su tutto — ha trovato una data race reale al primo tentativo
- `gofmt -l` che fallisce se produce output
- suite backend eseguita **tre volte**: i test instabili sono peggio di quelli rotti,
  perché insegnano a rieseguire finché non diventa verde
- il controllo che nessun file committato contenga un segreto valorizzato (esiste
  già come test)

---

## 8. Deployment oltre il Mac

Lo stack gira oggi su Docker Desktop. Il percorso verso bare metal, Proxmox o VPS:

- **Nessuna dipendenza da Docker Desktop.** Compose funziona identico su Docker
  Engine Linux. Da verificare: i bind su `127.0.0.1` vanno rivisti quando il
  servizio deve essere raggiungibile.
- **Proxmox**: una VM per il control plane, una per PostgreSQL, e il terzo votante
  etcd **fuori dal cluster Proxmox** — altrimenti la perdita dell'host porta via
  quorum e dati insieme.
- **Chart Helm e manifest Kustomize esistono già** in `charts/` e `k8s/`. Non sono
  mai stati applicati a un cluster reale: vanno provati prima di considerarli validi.
- **La password PostgreSQL è incisa nel volume alla prima inizializzazione.**
  Cambiare la variabile d'ambiente non la ruota. La rotazione si fa con
  `ALTER USER ... PASSWORD`, non ricreando il container.

---

*Ogni misura in questo documento è riproducibile. I metodi sono in `AUDIT_INVENTARIO.md`.*
