# Setup MetaTrader 5 — Expert Advisor AKRAM (Pepperstone)

Questo modulo (`mt5/AKRAM_MeanReversion_EA.mq5`) è **completamente
separato** dal bot Node.js/BitGet nel resto del progetto: MetaTrader 5
non è un exchange con API REST, è un terminale desktop che si
automatizza da dentro l'applicazione stessa. Per questo la stessa
strategia "AKRAM Mean Reversion v2.0" qui è riscritta come Expert
Advisor MQL5, non come script Node.js.

## ⚠️ Limite tecnico, non aggirabile

Un Expert Advisor MT5 gira **solo dentro il terminale MetaTrader 5
installato su un PC Windows** (o Wine, non ufficialmente supportato),
con quel terminale aperto e collegato al tuo account. Non esiste un
modo per farlo girare su un server cloud headless: per questo il codice
qui sotto va installato ed eseguito sul **tuo** computer — nessuna
sessione cloud, inclusa questa, può avviarlo al posto tuo.

## 🔐 Le tue credenziali restano solo tue

Login, password e server non vanno mai scritti in un file, in questa
chat o nel codice: **il login a MT5 si fa dentro il terminale stesso**,
con la finestra "Accedi al Trading Account" (File → Accedi al Trading
Account), inserendo lì:

- Login: `62129448`
- Server: `PepperstoneUK-Demo`
- Password: quella che hai già (e che ti consiglio di non incollare mai
  più in una chat, dato che l'hai già fatto una volta in questa
  conversazione)

L'Expert Advisor, una volta avviato, opera automaticamente sull'account
già collegato nel terminale — il file `.mq5` non contiene né richiede
credenziali. Questo è anche il motivo per cui questo approccio (EA
nativo) è preferibile a un bridge esterno via script: elimina del tutto
il problema di dover maneggiare una password in un file.

Dato che il server è "Demo", i fondi non sono reali — ma verifica
sempre tu stesso nel terminale a quale account/server sei
effettivamente collegato prima di ogni sessione.

## Installazione

1. **Apri MetaTrader 5** e accedi con le tue credenziali come sopra.
2. **Apri MetaEditor**: nel terminale MT5, premi `F4` (o Strumenti →
   MetaEditor).
3. Copia il file `mt5/AKRAM_MeanReversion_EA.mq5` di questo progetto
   dentro la cartella `MQL5/Experts/` del tuo terminale — in MT5:
   File → Apri cartella dati → `MQL5/Experts/` — poi aprilo da lì in
   MetaEditor (oppure incolla il contenuto in un nuovo Expert Advisor
   creato da MetaEditor con lo stesso nome).
4. **Compila**: premi `F7`. Nella scheda "Errori" in basso deve
   comparire `0 errori, 0 avvisi` (solo avvisi va bene, errori no).
5. Torna in MT5, apri il grafico del simbolo che vuoi tradare (es.
   EURUSD, o l'equivalente disponibile su Pepperstone) sul timeframe
   che preferisci — l'EA userà quel timeframe per calcolare RSI,
   Bollinger, EMA e ATR.
6. Nel pannello **Navigatore** (`Ctrl+N`) trova l'EA sotto
   "Expert Advisors" e trascinalo sul grafico.
7. Nella finestra che si apre, scheda **"Comuni"**: spunta **"Consenti
   Trading algoritmico"**. Rivedi i parametri nella scheda "Input"
   (stessi concetti di `rules.json`: RSI, Bollinger, EMA, ATR, rischio
   per trade — vedi tabella sotto) e conferma.
8. Verifica in alto nel terminale che il pulsante **"Algo Trading"** sia
   attivo (verde). Sul grafico deve comparire una faccina 🙂 in alto a
   destra: significa che l'EA è attivo.
9. Segui i log in tempo reale nella scheda **"Esperti"** in basso nel
   terminale.

## Parametri principali (scheda "Input" dell'EA)

| Parametro | Default | Significato |
|---|---|---|
| `InpRsiPeriod` / `InpRsiOverbought` / `InpRsiOversold` | 14 / 70 / 30 | Stesse soglie di `rules.json` |
| `InpBbPeriod` / `InpBbDeviation` | 20 / 2.0 | Bollinger Bands |
| `InpEmaFast` / `InpEmaMedium` / `InpEmaSlow` | 20 / 50 / 200 | Filtro di trend (l'entry usa EmaSlow, EmaFast è usata anche come uscita) |
| `InpAtrStopMult` / `InpAtrTargetMult` | 1.5 / 3.0 | Stop loss / take profit in multipli di ATR |
| `InpRiskPercent` | 1.0 | % di equity rischiata per trade — determina il lotto in automatico in base al valore del tick dello strumento |
| `InpMaxPositions` | 2 | Posizioni contemporanee massime su quel simbolo |
| `InpMaxTradesPerDay` | 3 | Nuovi ingressi massimi al giorno |
| `InpMaxDrawdownPct` | 20 | Sopra questa soglia l'EA smette di aprire nuovi trade (le posizioni già aperte restano gestite dai loro SL/TP) |
| `InpMagicNumber` | 20260814 | Identificativo interno per distinguere i trade di questo EA da altri |

## Differenze rispetto al bot Node.js/BitGet

- Stop loss e take profit qui sono ordini nativi del broker (impostati
  alla creazione della posizione), non calcolati e inviati da uno
  script esterno come nel bot Node.js — più robusto: continuano a
  valere anche se il terminale si disconnette temporaneamente.
- Il position sizing usa i lotti forex/CFD (`SYMBOL_VOLUME_MIN/STEP/MAX`),
  non una size in USD come su BitGet: `InpRiskPercent` converte
  automaticamente rischio → lotti in base al valore del tick dello
  strumento.
- Non esiste una modalità "paper trading" separata via codice come
  `PAPER_TRADING=true` nel bot Node.js: qui la sicurezza viene dal
  fatto che sei collegato al server **Demo** di Pepperstone, più dai
  limiti di rischio della tabella sopra. Prima di collegare l'EA a un
  eventuale account live in futuro, rivedi ogni parametro con calma.

## Verificare che funzioni senza aspettare un segnale reale

Nella scheda "Strategy Tester" di MT5 (`Ctrl+R`) puoi selezionare questo
EA, il simbolo, un intervallo storico e lanciare un backtest: è il modo
più veloce per vedere l'EA piazzare ordini simulati sui dati storici
senza dover aspettare che le condizioni RSI/Bollinger si verifichino
dal vivo.
