# OKX — non ancora collegato

Guida di riferimento per un'estensione futura — non implementato nel
bot attuale.

## Cosa servirebbe

- **Autenticazione**: header `OK-ACCESS-KEY`, `OK-ACCESS-SIGN`,
  `OK-ACCESS-TIMESTAMP`, `OK-ACCESS-PASSPHRASE` — concettualmente
  simile a BitGet (che si ispira allo stesso schema), quindi
  `signBitGet()` sarebbe il punto di partenza più vicino da adattare.
- **Endpoint candele**:
  `GET /api/v5/market/candles?instId=BTC-USDT&bar=1H`
- **Endpoint ordine**: `POST /api/v5/trade/order` con `instId`,
  `tdMode`, `side`, `ordType`, `sz`.
- **Permessi API key**: da okx.com → **API**, permessi "Lettura" e
  "Trading"; **non** abilitare "Prelievo".

## Se vuoi aggiungerlo

Perché OKX e BitGet condividono lo stile di firma, adattare
`bitGetRequest()` in una funzione generica parametrizzata per
host/header è probabilmente più semplice che scriverne una da zero.
