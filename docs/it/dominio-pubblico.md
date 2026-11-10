# Rendere NeroNet raggiungibile da Internet: dominio e DNS

Per collegare telefoni e computer fuori dalla tua rete locale, NeroNet ha bisogno di un nome
pubblico (per esempio `vpn.esempio.it`) che punti all'indirizzo IP della macchina dove gira.
Questa guida spiega due strade: **un dominio tuo** (consigliato, anche su Cloudflare) oppure
**un nome gratuito DuckDNS** se non vuoi pagare un dominio.

English version: [public-domain.md](../en/public-domain.md).

## Cosa deve essere raggiungibile

| Porta | Protocollo | Serve a |
|---|---|---|
| 80 | TCP | ottenere e rinnovare il certificato HTTPS (Let's Encrypt, HTTP-01) |
| 443 | TCP | la console web e il portale `/me` |
| 8443 | TCP | i nodi NeroNet parlano con il pannello di controllo |
| 51820 | UDP | WireGuard: il gateway per telefoni e computer, e i nodi |

Sul router di casa o dell'ufficio apri e inoltra queste porte verso la macchina NeroNet. Con
Podman senza privilegi le porte sotto 1024 non si pubblicano direttamente: inoltra la 80 e la 443
pubbliche verso le porte locali (8080 e 8443 di default), come spiegato in
[tls-certificates.md](../en/tls-certificates.md).

## Strada 1: un dominio tuo (per esempio su Cloudflare)

1. Nel pannello DNS del dominio crea questi record di tipo **A** (e **AAAA** se hai IPv6):

   | Nome | Valore | Cosa è |
   |---|---|---|
   | `vpn` | IP pubblico della macchina NeroNet | console, portale, pannello di controllo |
   | `gw.vpn` | IP del nodo gateway (spesso lo stesso) | dove si collegano telefoni e computer |

   Facoltativo, per i relay DERP su altre macchine: `derp-a.vpn`, `derp-b.vpn`.

2. **Su Cloudflare imposta ogni record su "Solo DNS" (nuvola grigia), non "Proxy" (arancione).**
   WireGuard usa UDP, che il proxy di Cloudflare non inoltra; e i nodi controllano l'impronta del
   certificato del pannello di controllo: con il proxy in mezzo vedrebbero il certificato di
   Cloudflare e rifiuterebbero la connessione. TTL: automatico.
3. Facoltativo ma consigliato: un record **CAA** `0 issue "letsencrypt.org"` sul dominio, così
   solo Let's Encrypt può emettere certificati per lui.
4. Se l'IP della tua connessione cambia (linea domestica), crea su Cloudflare un **token API**
   limitato a "Zone · DNS · Modifica" solo per quel dominio, e usa un programma di DNS dinamico
   (per esempio `ddclient`) per aggiornare il record. Non mettere mai il token nel repository.

## Strada 2: un nome gratuito DuckDNS

[DuckDNS](https://www.duckdns.org) dà gratis un nome del tipo `tuonome.duckdns.org`.

1. Accedi su duckdns.org, scegli un sottodominio (per esempio `miarete`) e copia il **token**
   che il sito ti mostra. Il token è una password: tienilo solo sulla macchina NeroNet.
2. Tieni aggiornato l'IP. Sulla macchina NeroNet salva il token in un file leggibile solo da te:

   ```sh
   install -m 600 /dev/null ~/.duckdns-token && printf '%s' 'IL_TUO_TOKEN' > ~/.duckdns-token
   ```

   e aggiorna l'IP ogni 5 minuti (cron):

   ```sh
   */5 * * * * curl -fsS "https://www.duckdns.org/update?domains=miarete&token=$(cat ~/.duckdns-token)&ip=" >/dev/null
   ```

   Lasciare `ip=` vuoto fa usare a DuckDNS l'indirizzo da cui arriva la richiesta.
3. Usa `miarete.duckdns.org` come nome pubblico. Let's Encrypt emette certificati anche per i nomi
   DuckDNS con HTTP-01, purché la porta 80 sia raggiungibile.

Limiti da conoscere: un nome DuckDNS dipende da un servizio gratuito di terzi; per un'azienda o
un ente usa un dominio proprio. Esistono anche altri servizi DNS gratuiti (per esempio deSEC).

## Avviare NeroNet con il nome pubblico

```sh
export NERONET_TLS_MODE=acme
export NERONET_PUBLIC_DOMAIN=vpn.esempio.it        # oppure miarete.duckdns.org
export NERONET_ACME_EMAIL=admin@esempio.it
export NERONET_ACME_AGREE_TOS=true
export NERONET_ACME_DIRECTORY=https://acme-staging-v02.api.letsencrypt.org/directory  # prima prova
sh scripts/dev/stack.sh up
```

Prima usa la directory di **prova** (staging) di Let's Encrypt; quando il certificato di prova
arriva, togli `NERONET_ACME_DIRECTORY` e riavvia per quello vero. Dettagli e rinnovi:
[tls-certificates.md](../en/tls-certificates.md).

## Scegliere il gateway per telefoni e computer

Nella console, come amministratore: **Impostazioni → Gateway per telefoni e computer**, scegli
il nodo e scrivi l'indirizzo pubblico, per esempio `gw.vpn.esempio.it:51820`. Da quel momento il
portale `/me` genera profili con quell'indirizzo, da aprire con l'app WireGuard (su iPhone l'app
ufficiale dall'App Store).

## Controllare che funzioni

Da un computer fuori dalla tua rete (per esempio dal telefono con il Wi-Fi spento):

```sh
nslookup vpn.esempio.it
curl -I https://vpn.esempio.it/
```

Il primo deve restituire il tuo IP pubblico; il secondo una risposta `HTTP/2 200` o un
reindirizzamento, senza errori di certificato.

## IP pubblico che cambia: aggiornare Cloudflare

Una linea domestica cambia ogni tanto IP pubblico. Il kit in `scripts/ops/cloudflare-ddns/`
controlla l'IP ogni 5 minuti e, solo se è cambiato, corregge i due record A su Cloudflare
(`neronet.darknero.com` e `gw.neronet.darknero.com` nell'esempio). Non crea mai record: creali una
volta a mano, "Solo DNS", poi il kit li tiene aggiornati.

**Il token, in parole semplici.** Su Cloudflare, Profilo, Token API, crea un token personalizzato
con un solo permesso: **Zona, DNS, Modifica**, e in "Risorse della zona" scegli **solo la tua zona**
(per esempio `darknero.com`). Quel token può cambiare i record DNS di quella sola zona e nient'altro:
non legge gli altri domini, la fatturazione o l'account. Se mai trapelasse, eliminalo su Cloudflare
e ne crei un altro. Non incollarlo nel repository, in chat o in una riga di comando.

**Installazione** (da root sulla VM, con `curl` e `jq` installati):

```sh
sudo bash scripts/ops/cloudflare-ddns/install.sh
```

L'installer copia lo script e il timer systemd, crea `/etc/neronet/ddns.env` (controlla
`ZONE_NAME` e `RECORD_NAMES`) e chiede il token con l'input nascosto. Il token resta in
`/etc/neronet/cloudflare-token` (modo 600); lo script si rifiuta di partire se modo o proprietario
sono sbagliati. Verifica con:

```sh
sudo /usr/local/sbin/neronet-ddns.sh --dry-run     # mostra cosa cambierebbe, non cambia nulla
systemctl list-timers neronet-ddns.timer
journalctl -u neronet-ddns -n 20
```

L'IP pubblico viene chiesto a due servizi indipendenti (`https://api.ipify.org` e
`https://ifconfig.co/ip`, modificabili con `IP_SOURCES` in `ddns.env`). Se non concordano, o la
risposta non è un indirizzo IPv4 pubblico, non viene cambiato nulla. Per rimuovere tutto:
`sudo bash scripts/ops/cloudflare-ddns/install.sh --uninstall` (con `--purge` elimina anche il token).

Test: `sh scripts/ops/cloudflare-ddns/test.sh` (Cloudflare finto, mai quello vero).

## Dietro un reverse proxy già esistente (per esempio Nginx Proxy Manager)

Se un reverse proxy occupa già le porte 80 e 443 della tua rete, metti la console dietro di lui:

1. Nel proxy crea un **Proxy Host** per il tuo nome (per esempio `neronet.darknero.com`). Inoltra con
   schema **https** all'indirizzo della VM e alla **porta della console** (`NERONET_CONSOLE_PORT`,
   vedi [tls-certificates.md](tls-certificates.md)). La console usa un suo certificato, quindi il
   proxy non deve verificare il certificato a monte (in Nginx Proxy Manager con https è già così).
2. Attiva **Websockets Support**. Senza, le pagine "in diretta" della console restano vuote.
3. Nella scheda SSL richiedi il certificato **al proxy** (Let's Encrypt) e attiva Force SSL.
   In questo schema è il proxy, non NeroNet, a rispondere alla verifica HTTP-01 sulla porta 80.
4. **Non far passare questi due dal proxy**: inoltrali direttamente dal router alla VM:
   - **TCP 8443**, il control plane: i nodi fissano (pin) il certificato del control plane, quindi un
     proxy che ricifra il traffico con un suo certificato fa rifiutare la connessione ai nodi.
   - **UDP 51820**, WireGuard: un proxy web non trasporta UDP.
   Controlla che il proxy stesso non usi la 8443; se la usa, sposta la porta di amministrazione del proxy.
5. Lascia i record DNS "Solo DNS" e puntati all'IP pubblico (vedi la sezione sopra).

Verifica: da fuori `curl -I https://neronet.darknero.com/` risponde normalmente con certificato
valido, e un nodo si collega ancora.
