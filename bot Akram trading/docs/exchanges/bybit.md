# Bybit — non ancora collegato

Come per Binance, questa è una guida di riferimento per un'estensione
futura: il bot in questa versione parla solo con BitGet.

## Cosa servirebbe

- **Autenticazione**: HMAC-SHA256 su `timestamp + api_key + recv_window
  + query/body`, con header `X-BAPI-API-KEY`, `X-BAPI-SIGN`,
  `X-BAPI-TIMESTAMP`, `X-BAPI-RECV-WINDOW` — schema diverso da quello
  BitGet già implementato in `signBitGet()`.
- **Endpoint candele**:
  `GET /v5/market/kline?category=spot&symbol=BTCUSDT&interval=60`
- **Endpoint ordine**: `POST /v5/order/create` con `category`, `symbol`,
  `side`, `orderType`, `qty`.
- **Permessi API key**: da bybit.com → **API Management**, spuntare
  solo "Orders" e "Positions" in lettura/scrittura; lasciare
  disattivato "Withdrawal".

## Se vuoi aggiungerlo

Stesso approccio suggerito per Binance: un modulo `bybitRequest()`
dedicato selezionato da `EXCHANGE=bybit`, e un adattatore per il
formato delle candele in `processCandles()`.
