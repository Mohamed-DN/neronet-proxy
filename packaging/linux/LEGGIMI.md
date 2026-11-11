# neronet per Linux

`neronet` collega il computer a un profilo NeroNet. Crea una connessione cifrata (WireGuard),
imposta gli indirizzi e le rotte, usa il DNS di systemd-resolved e, con l'interruttore di
sicurezza (kill switch), blocca tutto il traffico che non passa dal tunnel. Il servizio
`neronet@.service` avvia un tunnel per ogni profilo.

Requisiti: una distribuzione Linux con systemd, `nftables`, il dispositivo `/dev/net/tun` e
systemd-resolved per il DNS (consigliato; senza, il tunnel parte ma il DNS non viene impostato).
I pacchetti sono per `amd64` e `arm64`.

## Installazione (Debian, Ubuntu e derivate)

```sh
sudo apt install ./neronet_<versione>_<architettura>.deb
```

Il pacchetto installa il programma `/usr/bin/neronet` e il servizio. Non avvia e non attiva
nulla da solo.

## Installazione da archivio .tar.gz

```sh
tar xzf neronet-<versione>-linux-<architettura>.tar.gz
cd neronet-<versione>-linux-<architettura>
sudo install -m 0755 neronet /usr/local/bin/neronet
sudo install -m 0644 neronet@.service /etc/systemd/system/neronet@.service
sudo systemctl daemon-reload
```

Se usi `/usr/local/bin`, nel file `/etc/systemd/system/neronet@.service` cambia le righe
`ExecStart` e `ExecStop` in modo che indichino `/usr/local/bin/neronet`.

## Collegare un profilo

1. Scarica dal portale NeroNet il profilo di questo dispositivo. È un file di configurazione
   WireGuard con alcune righe di commento NeroNet (`# NeroNet-Profile: 1`).
2. Copialo in `/etc/neronet/` con un nome a tua scelta, per esempio `casa`. Il file contiene
   una chiave privata, quindi deve poterlo leggere solo root:

   ```sh
   sudo install -d -m 0700 /etc/neronet
   sudo install -m 0600 -o root -g root ~/Scaricati/profilo.conf /etc/neronet/casa.conf
   ```

3. Avvia il tunnel adesso e ad ogni accensione:

   ```sh
   sudo systemctl enable --now neronet@casa
   ```

4. Controlla che funzioni:

   ```sh
   sudo neronet status
   systemctl status neronet@casa
   ```

   `status` mostra l'interfaccia, il peer, il momento dell'ultimo contatto (handshake) e il
   traffico. Se l'handshake non compare mai, il tunnel non trasporta traffico.

Per fermare il tunnel: `sudo systemctl disable --now neronet@casa`. Fermando il servizio viene
eseguito `neronet down`, che rimuove l'interfaccia, le rotte, le impostazioni DNS e le regole
dell'interruttore di sicurezza.

## Interruttore di sicurezza

Il servizio avvia sempre il tunnel con l'interruttore di sicurezza. Mentre il tunnel è attivo,
la tabella `inet neronet` di nftables blocca il traffico in uscita, tranne quello verso
l'interfaccia del tunnel, il loopback e i pacchetti WireGuard verso il server del profilo. Se
il processo del tunnel si blocca, le regole possono restare attive: il servizio riparte da solo
dopo 5 secondi, oppure puoi eseguire `sudo neronet down`. Finché le regole restano, il computer
non ha connessione, a parte il server del tunnel.

## Log

```sh
journalctl -u neronet@casa
```

## Disinstallazione

```sh
sudo systemctl disable --now 'neronet@*'
sudo apt remove neronet          # oppure: sudo apt purge neronet
```

`apt remove` lascia i profili in `/etc/neronet/`. Se non ti servono più, cancella quella cartella
tu stesso: contengono le chiavi private. Per l'installazione da archivio, rimuovi
`/usr/local/bin/neronet` e `/etc/systemd/system/neronet@.service`, poi esegui
`sudo systemctl daemon-reload`.

## Note

- Il servizio gira come root, ma con i soli permessi di rete necessari (`CAP_NET_ADMIN` e
  `CAP_NET_RAW`) e può usare solo `/dev/net/tun`.
- Il tunnel usa WireGuard in user space: non serve nessun modulo del kernel.
- Questa è la versione 0 del client. I comandi disponibili sono `up [--kill-switch] <profilo>`,
  `down`, `status` e `version`.
- L'indirizzo del manutentore nel pacchetto (`DarkNero <packages@neronet.invalid>`) è un segnaposto; sostituiscilo prima di pubblicare il pacchetto.
