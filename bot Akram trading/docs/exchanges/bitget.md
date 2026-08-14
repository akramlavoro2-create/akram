# BitGet — configurazione API per il bot AKRAM

BitGet è l'unico exchange collegato in questa versione del bot (vedi
`bot.js`, funzione `bitGetRequest`). Le guide per Binance, Bybit e OKX
in questa cartella descrivono cosa servirebbe per aggiungerli: **non
sono ancora implementati nel codice**, sono riferimento per
un'estensione futura.

## 1. Crea la API Key

1. Accedi a bitget.com → **Profilo → Gestione API**.
2. Crea una nuova API Key dedicata a questo bot (non riusare chiavi già
   usate altrove: se una viene compromessa, revocarla non deve rompere
   altri strumenti).
3. Permessi da assegnare:
   - ✅ **Lettura** (necessaria per prezzi/candele/saldo)
   - ✅ **Trading spot** (necessaria per aprire/chiudere ordini)
   - ❌ **Prelievo** — NON abilitarlo mai su una API key usata da un
     bot. Se le chiavi venissero compromesse, senza permesso di
     prelievo l'attaccante non può portare via fondi, solo tradare con
     quelli già presenti.
4. Imposta una **whitelist IP** se il bot gira sempre dallo stesso
   server/IP fisso (es. l'IP assegnato da Railway). In locale su IP
   dinamico questo campo può essere lasciato vuoto, ma è meno sicuro.
5. Copia i tre valori generati in `.env` (mai altrove, mai in chat):
   - `BITGET_API_KEY`
   - `BITGET_SECRET_KEY`
   - `BITGET_PASSPHRASE` (scelta da te al momento della creazione — non
     è la password del tuo account BitGet, è specifica della API key)

## 2. Endpoint usati dal bot

- `GET /api/v2/spot/market/candles` — dati OHLCV
- `POST /api/v2/spot/trade/place-order` — apertura/chiusura ordini market

## 3. Limiti da conoscere

- Rate limit standard BitGet: dell'ordine di 10 richieste/secondo per
  endpoint pubblico, meno per quelli privati — il ciclo del bot (1
  richiesta al minuto) resta ben sotto soglia.
- Gli ordini "market" su spot vengono eseguiti al prezzo corrente: su
  simboli poco liquidi lo slippage può essere più alto di quanto l'ATR
  calcolato lascia intendere — un `MAX_TRADE_SIZE_USD` basso aiuta a
  limitare il danno.

## 4. Errori comuni

| Errore | Causa probabile |
|---|---|
| Signature invalid | Secret key o passphrase sbagliate in `.env`, oppure orologio di sistema non sincronizzato (BitGet rifiuta timestamp troppo vecchi/nuovi) |
| Permesso negato sull'ordine | Trading spot non abilitato sulla API key |
| Nessun dato dalle candele | Simbolo scritto in un formato diverso da quello richiesto da BitGet — verifica il formato esatto nella documentazione API corrente di BitGet prima di andare live |

## 5. Prima di passare da paper a live

- Verifica in `trades.csv` che `PAPER_TRADING=true` abbia prodotto
  risultati sensati per almeno alcune settimane/decine di trade.
- Parti con `MAX_TRADE_SIZE_USD` e `PORTFOLIO_VALUE_USD` bassi finché
  non hai fiducia nel comportamento del bot in condizioni reali
  (slippage, latenza, code d'ordine).
