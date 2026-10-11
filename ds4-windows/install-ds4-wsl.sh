#!/usr/bin/env bash
# Installa e compila DwarfStar (antirez/ds4) dentro WSL2 / Ubuntu.
# Uso:  bash install-ds4-wsl.sh [--cpu] [--model NOME]
#   --cpu          forza la build solo-CPU anche se c'e' una GPU NVIDIA
#   --model NOME   scarica anche il modello (es. qwen38-q2, ds4f-q2)
set -euo pipefail

DS4_DIR="${DS4_DIR:-$HOME/ds4}"
FORCE_CPU=0
MODEL=""
while [ $# -gt 0 ]; do
    case "$1" in
        --cpu) FORCE_CPU=1 ;;
        --model) MODEL="${2:?manca il nome del modello}"; shift ;;
        *) echo "Opzione sconosciuta: $1"; exit 2 ;;
    esac
    shift
done

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }

if [ "$(uname -s)" != "Linux" ]; then
    echo "Questo script va eseguito dentro WSL2 (Ubuntu), non in Windows."; exit 1
fi
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

say "Installo i pacchetti di base (compilatore, git, curl)"
$SUDO apt-get update -y
$SUDO apt-get install -y build-essential git curl ca-certificates pciutils

say "Scarico/aggiorno DwarfStar in $DS4_DIR"
if [ -d "$DS4_DIR/.git" ]; then
    git -C "$DS4_DIR" pull --ff-only
else
    git clone https://github.com/antirez/ds4.git "$DS4_DIR"
fi
cd "$DS4_DIR"

# In WSL2 il driver NVIDIA di Windows espone nvidia-smi in /usr/lib/wsl/lib.
export PATH="$PATH:/usr/lib/wsl/lib"
BACKEND=cpu
if [ "$FORCE_CPU" -eq 0 ] && command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
    BACKEND=cuda
    say "GPU NVIDIA trovata:"
    nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader
else
    warn "Nessuna GPU NVIDIA visibile in WSL: compilo la versione solo-CPU (molto lenta)."
fi

if [ "$BACKEND" = cuda ]; then
    if ! [ -x /usr/local/cuda/bin/nvcc ] && ! command -v nvcc >/dev/null 2>&1; then
        say "Installo il CUDA Toolkit per WSL-Ubuntu (circa 3-4 GB)"
        # Repository ufficiale NVIDIA per WSL: NON installa driver Linux,
        # in WSL si usa il driver di Windows.
        tmp="$(mktemp -d)"
        curl -fsSL -o "$tmp/cuda-keyring.deb" \
            https://developer.download.nvidia.com/compute/cuda/repos/wsl-ubuntu/x86_64/cuda-keyring_1.1-1_all.deb
        $SUDO dpkg -i "$tmp/cuda-keyring.deb"
        rm -rf "$tmp"
        $SUDO apt-get update -y
        $SUDO apt-get install -y cuda-toolkit
    fi
    if ! grep -q '/usr/local/cuda/bin' "$HOME/.bashrc" 2>/dev/null; then
        printf '\n# CUDA per DwarfStar\nexport PATH=/usr/local/cuda/bin:/usr/lib/wsl/lib:$PATH\nexport LD_LIBRARY_PATH=/usr/local/cuda/lib64:/usr/lib/wsl/lib:${LD_LIBRARY_PATH:-}\n' >> "$HOME/.bashrc"
    fi
    export PATH="/usr/local/cuda/bin:$PATH"
    export LD_LIBRARY_PATH="/usr/local/cuda/lib64:/usr/lib/wsl/lib:${LD_LIBRARY_PATH:-}"

    say "Compilo DwarfStar per CUDA (make cuda-generic)"
    if ! make cuda-generic -j"$(nproc)"; then
        warn "Build CUDA fallita: ripiego sulla build solo-CPU."
        make clean >/dev/null 2>&1 || true
        BACKEND=cpu
    fi
fi
if [ "$BACKEND" = cpu ]; then
    say "Compilo DwarfStar solo-CPU (make cpu)"
    make cpu -j"$(nproc)"
fi

say "Verifica dei programmi compilati"
for b in ds4 ds4-server ds4-agent ds4-eval ds4-bench; do
    [ -x "./$b" ] || { echo "ERRORE: $b non e' stato creato"; exit 1; }
done
./ds4 --help >/dev/null
echo "OK: ds4, ds4-server, ds4-agent, ds4-eval, ds4-bench funzionano (backend: $BACKEND)"

# --- Controllo risorse e consiglio sul modello ---------------------------
ram_gib=$(awk '/MemTotal/ {printf "%d", $2/1048576}' /proc/meminfo)
disk_gib=$(df -BG --output=avail "$DS4_DIR" | tail -1 | tr -dc '0-9')
vram_gib=0
if [ "$BACKEND" = cuda ]; then
    vram_gib=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | awk '{s+=$1} END {printf "%d", s/1024}')
fi
say "Risorse viste da WSL: RAM ${ram_gib} GiB, VRAM ${vram_gib} GiB, disco libero ${disk_gib} GiB"
echo "Requisiti minimi dei modelli piu' piccoli:"
echo "  qwen38-q2 : ~42 GiB di pesi in memoria + 137 GiB su disco (consigliato >= 64 GB)"
echo "  ds4f-q2   : ~81 GiB di pesi in memoria + 81 GiB su disco   (consigliato 96/128 GB)"
mem_total=$((ram_gib + vram_gib))
if [ "$mem_total" -lt 48 ]; then
    warn "Con ${mem_total} GiB tra RAM e VRAM nessun modello supportato entra in memoria:"
    warn "il programma e' installato ma i modelli non possono girare in modo utilizzabile."
fi

if [ -n "$MODEL" ]; then
    say "Scarico il modello $MODEL (puo' richiedere ore; rilancia per riprendere)"
    ./download_model.sh "$MODEL"
fi

cat <<MSG

==================================================================
 DwarfStar installato in: $DS4_DIR   (backend: $BACKEND)
==================================================================
 Per usarlo, apri Ubuntu (WSL) e digita:
   cd $DS4_DIR
   ./download_model.sh qwen38-q2        # scarica un modello (una volta)
   ./ds4 --ctx 8192 -p "Ciao!"          # prompt singolo
   ./ds4                                # chat interattiva
   ./ds4-agent                          # agente di programmazione
   ./ds4-server --ctx 32768             # server API su http://127.0.0.1:8000
 Con GPU NVIDIA aggiungi:  --cuda --gpu-vram auto
MSG
