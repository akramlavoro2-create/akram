# DwarfStar (ds4) su Windows

DwarfStar ([antirez/ds4](https://github.com/antirez/ds4)) **non supporta Windows
nativamente**: gira su macOS (Metal) e Linux (CUDA, ROCm, CPU). Su Windows lo
si installa dentro **WSL2 + Ubuntu**, che è Linux vero e può usare la GPU NVIDIA.

## Installazione (3 passi)

1. Scarica questa cartella `ds4-windows` sul PC (es. in `C:\ds4-windows`).
2. Doppio clic su **`INSTALLA.bat`** e accetta la richiesta di amministratore.
   - La prima volta installa WSL2 + Ubuntu: **riavvia il PC**, apri *Ubuntu*
     dal menu Start e crea nome utente e password.
3. Doppio clic di nuovo su **`INSTALLA.bat`**: installa dipendenze, CUDA
   Toolkit (se hai una GPU NVIDIA), scarica e compila DwarfStar in `~/ds4`.

Opzioni da PowerShell (come amministratore):

```powershell
powershell -ExecutionPolicy Bypass -File .\install-ds4-windows.ps1 -Model qwen38-q2   # scarica anche il modello
powershell -ExecutionPolicy Bypass -File .\install-ds4-windows.ps1 -Cpu               # forza solo-CPU
```

## Uso

Apri *Ubuntu* dal menu Start:

```bash
cd ~/ds4
./download_model.sh qwen38-q2          # una volta, ~137 GiB
./ds4 --ctx 8192 -p "Ciao!"            # aggiungi --cuda --gpu-vram auto con GPU NVIDIA
./ds4                                  # chat
./ds4-agent                            # agente di programmazione
./ds4-server --ctx 32768               # API su http://127.0.0.1:8000
```

## Requisiti hardware (importante)

| Modello     | Memoria (RAM+VRAM) | Disco    |
|-------------|--------------------|----------|
| `qwen38-q2` | ≥ 64 GB            | 137 GiB  |
| `ds4f-q2`   | 96–128 GB          | 81 GiB   |

Con un PC normale (16–32 GB di RAM) il programma si installa e si compila, ma
**nessun modello supportato entra in memoria**. Serve una GPU NVIDIA con driver
Windows aggiornato per avere velocità utilizzabili; AMD/Intel su Windows
possono usare solo la CPU (molto lento).

Lo script imposta `%UserProfile%\.wslconfig` per dare a WSL quasi tutta la RAM
(il default è metà); il vecchio file viene salvato come `.wslconfig.bak`.
