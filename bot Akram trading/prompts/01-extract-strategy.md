# Prompt: estrazione di una strategia in rules.json

Usa questo prompt con Claude (o un altro LLM) quando vuoi trasformare la
descrizione di una strategia di trading — presa da un post, un video, un
PDF o scritta a mano — nel formato `rules.json` usato dal bot AKRAM.

## Come usarlo

1. Copia il prompt qui sotto.
2. Incolla dopo `--- STRATEGIA DA CONVERTIRE ---` il testo/trascrizione
   della strategia che vuoi implementare.
3. Rivedi sempre a mano l'output prima di usarlo in live trading — è un
   punto di partenza, non una garanzia di correttezza.

---

Sei un analista quantitativo. Il tuo compito è leggere la descrizione di
una strategia di trading e convertirla nello schema JSON usato dal bot
AKRAM Trading, seguendo ESATTAMENTE questa struttura:

- `entry_rules.long` / `entry_rules.short`: array di regole, ognuna con
  `id`, `description`, `condition`, `severity` (`low`|`medium`|`high`),
  `weight` (numero, contributo al punteggio di ingresso).
- `exit_rules.long` / `exit_rules.short`: stesso formato ma senza
  `weight`.
- `risk_management`: `max_risk_per_trade_percent`,
  `stop_loss_atr_multiplier`, `take_profit_atr_multiplier`,
  `max_drawdown_percent`, `max_positions`, `risk_reward_ratio`,
  `trailing_stop_activation`, `trailing_stop_distance`.
- `indicators`: parametri di ogni indicatore usato (`rsi`,
  `bollinger_bands`, `ema`, `atr`, `volume`).
- `filters`: `min_volume`, `min_price`, `max_spread_percent`,
  `min_volatility_percent`.

Regole:
1. Le `condition` devono usare solo queste variabili: `rsi`, `close`,
   `price`, `bb_upper`, `bb_middle`, `bb_lower`, `ema_20`, `ema_50`,
   `ema_200`, `atr`, `high`, `low`, `volume`, `volume_ma_20`,
   `entry_price`.
2. Se la strategia descritta usa un indicatore non supportato dal
   motore attuale (es. MACD, Stocastico), segnalalo esplicitamente
   invece di inventare una condizione equivalente.
3. Se un parametro non è specificato nel testo originale, usa il
   default più comune per quell'indicatore e segnalalo come assunzione.
4. Non includere alcuna chiave che non abbia un chiaro corrispondente
   nella strategia descritta — niente regole "di riempimento".
5. Rispondi SOLO con il JSON finale, seguito da un elenco puntato delle
   assunzioni fatte.

--- STRATEGIA DA CONVERTIRE ---
[incolla qui la descrizione della strategia]
