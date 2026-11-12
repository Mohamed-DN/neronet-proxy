# Reti che bloccano le VPN: WireGuard sulla porta 443

Alcune reti (alberghi, uffici, Wi-Fi per ospiti) scartano ogni pacchetto UDP e lasciano passare
solo il web. WireGuard usa UDP, quindi lì un computer non si collega. NeroNet può portare gli
stessi pacchetti WireGuard dentro una WebSocket sulla porta TCP 443, quella dei siti web.

Guida completa, con quello che i test hanno misurato: [strict-networks.md](../en/strict-networks.md)
(in inglese).

## Sul server NeroNet

1. Aggiungi il segreto al file `.env` (una volta sola; il valore non viene mai stampato):

   ```sh
   sh scripts/dev/gen-env.sh --append-missing
   ```

2. Avvia il tunnel accanto al gateway, con queste variabili:

   ```sh
   NERONET_EXTRA_COMPOSE_FILE="docker-compose.proxy.yml docker-compose.gateway.yml docker-compose.wss.yml"
   NERONET_WSS_BIND=192.168.1.160
   NERONET_WSS_PORT=8444
   ```

   poi `sh scripts/dev/stack.sh up`.

## In Nginx Proxy Manager

Sul proxy host **già esistente** per il nome della console (per esempio `neronet.darknero.com`):

1. Apri il proxy host, scheda **Custom locations**, **Add location**.
2. **Define location**: `/` seguito dal valore di `NERONET_WSS_PATH_PREFIX` nel file `.env`
   (tutto il valore, senza barra finale).
3. **Scheme** `http`, **Forward Hostname / IP** `192.168.1.160`, **Forward Port** `8444`.
   È `http` perché il certificato lo gestisce già NPM.
4. Controlla che **Websockets Support** sia attivo sul proxy host (scheda Details): serve anche
   alla console.
5. Salva. Il resto non cambia: certificato, scheda SSL e console restano come sono.

Il **router non va toccato**: la porta TCP 443 arriva già a Nginx Proxy Manager e il tunnel passa
da lì. Non aprire la porta 8444 sul router: deve raggiungerla solo NPM.

## Sul computer

Dopo "Aggiungi un dispositivo", la pagina `/me` mostra la sezione "Reti che bloccano le VPN
(porta 443)" con il comando di wstunnel già compilato (Linux e macOS, Windows) e un secondo file
WireGuard (`<nome>-443.conf`) da usare al posto del primo quando la rete blocca UDP.

Sui telefoni con l'app WireGuard questo metodo non funziona: l'app non può avviare wstunnel.
