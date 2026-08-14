# Binance — non ancora collegato

Il bot attuale (`bot.js`) parla solo con l'API di BitGet. Questo file
descrive cosa cambierebbe per aggiungere Binance come exchange
alternativo — è una guida per un'estensione futura, non una
funzionalità già presente.

## Differenze principali rispetto a BitGet da gestire nel codice

- **Autenticazione**: Binance firma le richieste con HMAC-SHA256 sulla
  query string (header `X-MBX-APIKEY` + parametro `signature` nella
  query), non sull'intero body come fa `signBitGet()` in `bot.js` —
  servirebbe una funzione di firma separata.
- **Endpoint candele**: `GET /api/v3/klines?symbol=BTCUSDT&interval=1h`
  — formato di risposta diverso (array di array) da adattare in
  `processCandles()`.
- **Endpoint ordine**: `POST /api/v3/order` con parametri `symbol`,
  `side`, `type`, `quantity` (non `size` in USD come BitGet: Binance
  vuole la quantità nell'asset base, va convertita al prezzo corrente).
- **Permessi API key**: creare la key su binance.com → **Gestione API**
  con permesso "Enable Spot & Margin Trading" attivo e "Enable
  Withdrawals" **disattivato**.

## Se vuoi aggiungerlo

Serve un modulo `binanceRequest()` parallelo a `bitGetRequest()` in
`bot.js`, selezionato in base a `EXCHANGE=binance` in `.env`, più
l'adattamento di `processCandles()` al formato di risposta Binance.
