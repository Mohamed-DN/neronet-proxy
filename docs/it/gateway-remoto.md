# Un gateway su un server in un altro paese

Un gateway dei profili (ADR 0029) di solito gira accanto alla console. Questa guida è per il caso
in cui serve in un altro paese, su un server Linux con systemd e senza container, che ha già un
servizio TLS sulla porta 443 e nessuna porta libera. Il gateway serve solo VLESS + REALITY (ADR 0036)
e condivide la 443 con l'altro servizio tramite un router SNI. Decisioni e misure: ADR 0043.
Pacchetto e comandi: `packaging/gateway/README.md`.

## Che cosa vede il server remoto

Il server è un gateway: dopo che Xray ha decifrato la connessione di un dispositivo, il traffico esce
da quella macchina verso la mesh. Chi ha i permessi di root su quel server può quindi leggere in chiaro
il traffico dei dispositivi profilo, la chiave privata REALITY e i segreti SOCKS dei singoli dispositivi
mentre il servizio gira. Non vede il token di flotta (non viene mai installato), le chiavi degli altri
nodi né i dati della console. Scegli il server come sceglieresti chi può leggere quel traffico.

Il router SNI vede solo il nome (SNI) di ogni connessione. L'altro servizio, dopo lo scambio, vede
`127.0.0.1` come indirizzo del client, salvo che capisca il protocollo PROXY.

## Che cosa serve aprire

Niente di nuovo dal firewall: la 443 c'è già. Il pacchetto non apre, non avvia e non abilita nulla.
Xray ascolta solo su `127.0.0.1:8445`. Il nodo usa anche la UDP 51820 per la mesh: lasciala chiusa
sul firewall se non vuoi collegamenti WireGuard diretti. Il server deve raggiungere in uscita l'indirizzo
pubblico della console, in HTTPS verificato con la CA che hai installato.

## Passi

1. **Installa**: `sudo apt install ./neronet-gateway_<versione>_<arch>.deb`.
2. **Iscrivi il nodo senza token di flotta**: crea nella console una chiave di pre-autenticazione per
   questo gateway e mettila in `/var/lib/neronet-gateway/enrol.key` (modo 0600, utente `neronet-gw`).
   Il nodo la cancella dopo la registrazione. Metti la CA della console in
   `/etc/neronet-gateway/control-ca.pem` e compila `/etc/neronet-gateway/node.env`
   (`SOVEREIGN_CONTROL_PLANE_URL`, `SOVEREIGN_CONTROL_PLANE_CA`, `SOVEREIGN_VLESS_PORT=443`).
3. **Avvia**: `systemctl enable --now neronet-gateway-node` e poi
   `systemctl enable --now neronet-gateway-xray.path neronet-gateway-xray`.
4. **Prepara l'altro servizio** (lo fai tu, noi non lo tocchiamo): dagli un secondo ascolto su
   loopback (per esempio `127.0.0.1:8444`) mantenendo la 443 pubblica, e scrivi due comandi, uno che gli
   fa lasciare la 443 pubblica e uno che gliela restituisce. Provali a mano.
5. **Condividi la 443**: compila `/etc/neronet-gateway/swap.conf`, poi `neronet-443-swap plan`,
   `neronet-443-swap apply` (prova a vuoto) e `neronet-443-swap apply --yes`. Dopo lo scambio lo
   strumento sonda l'indirizzo pubblico con entrambi i nomi; se una sonda fallisce entro la scadenza
   torna indietro da solo.

Nella console il gateway compare con la porta pubblica (443), non con quella di loopback.

## Come tornare indietro

`sudo neronet-443-swap rollback` restituisce la 443 all'altro servizio subito. Poi, per togliere tutto:
`systemctl disable --now neronet-gateway-xray.path neronet-gateway-xray neronet-gateway-node` e
`apt remove neronet-gateway` (`apt purge` cancella anche stato, configurazione e utenti). Il pacchetto
rifiuta di essere rimosso finché il router è attivo, perché fermarlo toglierebbe la 443 anche all'altro
servizio.

## Che cosa è misurato

Nel test in container (`scripts/dev/test-remote-gateway.sh`, nginx e due server REALITY veri con due
client veri) l'altro servizio non ha perso nessuna richiesta durante lo scambio; un client con il nome
sbagliato o un uuid sconosciuto viene rifiutato e a chi non si autentica risponde il certificato del
sito di copertura; il rollback ripristina l'altro servizio in meno di un secondo.
