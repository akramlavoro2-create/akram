# Setup su Linux — bot Node.js/BitGet

Questa guida riguarda il bot in `bot.js` (Node.js + BitGet). MetaTrader
5 non è trattato qui: richiede Windows, vedi `docs/setup-mt5.md`.

## 1. Installa Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version
```

Su distribuzioni non basate su apt, usa il gestore pacchetti
equivalente o [nvm](https://github.com/nvm-sh/nvm).

## 2. Scarica il progetto

```bash
git clone <url-del-repository>
cd akram/"bot Akram trading"
npm install
```

## 3. Configura le credenziali

Modifica `.env` con le tue chiavi API BitGet reali (vedi
`docs/exchanges/bitget.md`). Mantieni `PAPER_TRADING=true` per i primi
test. Il file `.env` è già escluso da git tramite `.gitignore`: non
forzarne mai l'aggiunta con `git add -f`.

## 4. Avvia il bot

```bash
npm start
```

## 5. Farlo girare 24/7

- **systemd** (consigliato su un server Linux dedicato) — crea
  `/etc/systemd/system/akram-bot.service`:
  ```ini
  [Unit]
  Description=AKRAM Trading Bot
  After=network.target

  [Service]
  Type=simple
  WorkingDirectory=/percorso/assoluto/bot Akram trading
  ExecStart=/usr/bin/node bot.js
  Restart=on-failure
  EnvironmentFile=/percorso/assoluto/bot Akram trading/.env

  [Install]
  WantedBy=multi-user.target
  ```
  Poi:
  ```bash
  sudo systemctl daemon-reload
  sudo systemctl enable --now akram-bot
  sudo journalctl -u akram-bot -f   # segue i log in tempo reale
  ```

- **PM2** (alternativa più semplice, non richiede systemd):
  ```bash
  npm install -g pm2
  pm2 start bot.js --name akram-bot
  pm2 save
  pm2 startup   # segui le istruzioni stampate per l'avvio automatico al boot
  ```

- **Railway**: usa il `railway.json` già incluso nel progetto per un
  deploy gestito 24/7 senza mantenere un server tuo — imposta le
  variabili equivalenti a `.env` nel pannello Railway, non nel codice.

## 6. Fermare il bot

```bash
sudo systemctl stop akram-bot     # se usi systemd
pm2 stop akram-bot                # se usi PM2
```
