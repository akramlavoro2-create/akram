# Setup su Windows — bot Node.js/BitGet

Questa guida riguarda il bot in `bot.js` (Node.js + BitGet). Per
MetaTrader 5/Pepperstone vedi `docs/setup-mt5.md`, che è un modulo
completamente separato.

## 1. Installa Node.js

Scarica e installa Node.js 18 LTS o superiore da nodejs.org (installer
Windows). Verifica in PowerShell:

```powershell
node --version
npm --version
```

## 2. Scarica il progetto

Clona o scarica il branch del repository, poi apri PowerShell nella
cartella `bot Akram trading`:

```powershell
cd "bot Akram trading"
npm install
```

## 3. Configura le credenziali

Apri il file `.env` con un editor di testo e sostituisci i segnaposto
con le tue chiavi API BitGet reali (vedi `docs/exchanges/bitget.md` per
come crearle). Lascia `PAPER_TRADING=true` finché non hai verificato il
comportamento del bot in simulazione. Non condividere mai il contenuto
di `.env` in chat o repository pubblici — è già escluso da git tramite
`.gitignore`.

## 4. Avvia il bot

```powershell
npm start
```

I log appaiono a console e vengono salvati in `bot.log`; i trade
(simulati o reali) in `trades.csv`; le decisioni di safety-check in
`safety-check-log.json`.

## 5. Tenerlo acceso 24/7 (opzionale)

Su Windows il bot si ferma se chiudi la finestra PowerShell. Per farlo
girare in background in modo persistente:

- **PM2** (consigliato, cross-platform):
  ```powershell
  npm install -g pm2
  pm2 start bot.js --name akram-bot
  pm2 save
  pm2-startup install
  ```
- In alternativa, deploy su **Railway** (il file `railway.json` è già
  incluso nel progetto): collega il repository su railway.app, imposta
  su Railway le stesse variabili presenti in `.env` (mai nel codice), e
  Railway lo tiene attivo 24/7 senza che il tuo PC debba restare acceso.

## 6. Fermare il bot

`Ctrl+C` nella finestra del terminale (oppure `pm2 stop akram-bot` se
avviato con PM2).
