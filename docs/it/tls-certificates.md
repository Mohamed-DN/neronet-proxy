# Certificati della console e dei nodi

NeroNet supporta CA interna e ACME HTTP-01. Entrambe servono console e API dei nodi
in HTTPS. La modalità interna resta quella predefinita. La chiave dell'account
ACME rimane in un volume privato; nginx riceve soltanto certificato, chiave del
server e directory delle challenge HTTP-01.

## CA interna

Esegui `sh scripts/dev/stack.sh up`. Un checkout nuovo genera la CA di sviluppo in
`certs/`; i nodi fissano `certs/ca.crt`. Per un'installazione sostituisci
`server.crt` e `server.key` con la coppia emessa dalla tua CA e `ca.crt` con la sua
catena di fiducia. Il certificato deve coprire `frontend`, oppure configura
`-control-url` dei nodi con un nome coperto. Chiavi private e `.env` restano fuori
dal controllo versione.

## Dominio pubblico con ACME

HTTP-01 richiede un dominio pubblico reale, record A/AAAA diretti a questo host e
porta TCP 80 raggiungibile. Un reverse proxy può inoltrare la porta 80 al listener
HTTP-01 di nginx, preservando `/.well-known/acme-challenge/`. Non sono supportati
wildcard o DNS-01. Prima usa la directory staging della CA per controllare DNS e
firewall, poi richiedi il certificato riconosciuto dai browser.

Da Git Bash su Windows, oppure da una shell POSIX:

```sh
export COMPOSE_PROJECT_NAME=my-neronet
export NERONET_TLS_MODE=acme
export NERONET_PUBLIC_DOMAIN=vpn.example.org
export NERONET_ACME_EMAIL=admin@example.org
export NERONET_ACME_AGREE_TOS=true
export NERONET_CONSOLE_BIND=0.0.0.0
export NERONET_HTTP_PORT=80
export NERONET_CONSOLE_PORT=443
export NERONET_CONSOLE_PUBLIC_PORT=443
export NERONET_ACME_DIRECTORY=https://acme-staging-v02.api.letsencrypt.org/directory
sh scripts/dev/stack.sh up
```

Podman rootless in genere non può pubblicare le porte host 80 e 443. In quel caso
mantieni i default (HTTP 8080 e HTTPS 8443, più l'eventuale offset), imposta
`NERONET_CONSOLE_PUBLIC_PORT=443` e inoltra le porte pubbliche 80/443 a questi
listener con un reverse proxy sull'host o un inoltro di porte. La CA deve comunque
poter raggiungere HTTP-01 sulla porta pubblica 80.

`NERONET_ACME_AGREE_TOS=true` indica che l'operatore accetta i termini della CA
selezionata. La directory predefinita è quella di produzione di Let's Encrypt.
I certificati staging non sono riconosciuti dai browser: non disattivare la
verifica dei client. Usa un progetto staging separato, con volumi propri per
account e certificati; dopo la prova, usa un progetto nuovo per la produzione.

Nel Compose il dominio diventa un alias DNS della console: i nodi verificano quel
nome. Con CA pubbliche usano le radici del sistema. Con una CA ACME privata,
`NERONET_CONTROL_PLANE_CA_FILE` indica la radice che firma il certificato HTTPS
della console e delle API; per la fiducia nell'endpoint ACME usa separatamente
`NERONET_ACME_DIRECTORY_CA_FILE` e
`NERONET_ACME_CA_CERTIFICATES=/run/secrets/acme_directory_ca`.

Prima dell'emissione nginx rifiuta le connessioni TLS e risulta non sano; HTTP-01
è già disponibile. Il servizio ACME controlla due volte al giorno per default
(`NERONET_ACME_CHECK_INTERVAL`, in secondi); lego decide quando rinnovare.
Nginx cerca un certificato nuovo ogni 30 secondi (`NERONET_TLS_WATCH_INTERVAL`) e
ricarica i worker. Se la CA non risponde, il certificato esistente rimane in uso
e il servizio riprova con attese crescenti. Monitora log e scadenza dei certificati.

L'immagine compila lego v5.5.2 fissato, con una piccola correzione del recupero:
se la prima indisponibilità della CA ha salvato l'account prima della registrazione,
il tentativo successivo registra la stessa chiave dopo che la CA conferma che
l'account non esiste. Gli altri errori ACME restano errori; un account già
registrato non viene sostituito.

Inserisci nel piano backup entrambi i volumi `acme_state` e `acme_public`: il primo
contiene la chiave dell'account. Non cancellarli per risolvere un problema di
rinnovo. Per forzare un rinnovo, con lo stesso ambiente Compose:

```sh
podman compose -f docker-compose.yml -f docker-compose.acme.yml exec -T acme \
  /usr/local/bin/acme-loop once --force
```

## Prova locale ripetibile

```sh
COMPOSE_PROJECT_NAME=neronet-acme-check NERONET_PORT_OFFSET=500 \
  sh scripts/dev/test-acme.sh
```

Servono un progetto dedicato nuovo e porte libere. La prova avvia due nodi veri
con CA interna e misura TCP nell'overlay; poi Pebble valida HTTP-01, si verifica
il certificato servito da nginx, si forza e si osserva il rinnovo, si prova un
rinnovo fallito e una pubblicazione malformata dopo riavvio e ricreazione. Controlla
anche il recupero della prima indisponibilità della CA senza cambiare la chiave
dell'account, poi misura TCP tra nodi che usano la CA ACME privata. Include un nodo
vero privo di quella CA, che deve rifiutare il certificato. La verifica
TLS e la validazione della challenge restano attive. Lo stack rimane acceso per
la revisione indipendente; `test-acme.sh renew` ripete le verifiche del rinnovo.
Pebble è una CA locale di test: questa prova non certifica un'emissione pubblica
di Let's Encrypt. La CI esegue lo stesso scenario.
