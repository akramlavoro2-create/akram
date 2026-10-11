# Installa DwarfStar (antirez/ds4) su Windows tramite WSL2 + Ubuntu.
# Eseguire da PowerShell COME AMMINISTRATORE:
#   powershell -ExecutionPolicy Bypass -File .\install-ds4-windows.ps1
# Opzioni: -Cpu (forza build solo-CPU)   -Model qwen38-q2 (scarica anche il modello)
param(
    [switch]$Cpu,
    [string]$Model = "",
    [string]$Distro = "Ubuntu-24.04"
)
$ErrorActionPreference = "Stop"

function Say($msg)  { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "[!] $msg" -ForegroundColor Yellow }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Warn "Apri PowerShell con 'Esegui come amministratore' e rilancia lo script."
    exit 1
}

$build = [Environment]::OSVersion.Version.Build
if ($build -lt 19041) {
    Warn "Windows troppo vecchio (build $build). Serve Windows 10 2004+ o Windows 11."
    exit 1
}

# --- Hardware --------------------------------------------------------------
$ramGB = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
$gpus  = Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name
Say "RAM: $ramGB GB   GPU: $($gpus -join ', ')"
if (-not ($gpus -match "NVIDIA")) {
    Warn "Nessuna GPU NVIDIA: su Windows DwarfStar potra' usare solo la CPU (molto lento)."
} else {
    Warn "Assicurati di avere il driver NVIDIA aggiornato (Game Ready/Studio) installato in Windows."
}

# --- WSL2 + Ubuntu ---------------------------------------------------------
$distros = @()
try { $distros = @((wsl.exe -l -q 2>$null) -replace "`0", "" | ForEach-Object { $_.Trim() } | Where-Object { $_ }) } catch {}
# Se c'e' gia' una Ubuntu installata, usa quella.
$existing = $distros | Where-Object { $_ -like "Ubuntu*" } | Select-Object -First 1
if ($existing -and -not ($distros -contains $Distro)) { $Distro = $existing }
if (-not ($distros -contains $Distro)) {
    Say "Installo WSL2 e $Distro"
    wsl.exe --install -d $Distro
    Write-Host ""
    Warn "PASSI SUCCESSIVI:"
    Warn " 1. Riavvia il computer (se richiesto)."
    Warn " 2. Apri 'Ubuntu' dal menu Start e crea nome utente e password."
    Warn " 3. Rilancia questo script come amministratore per completare l'installazione."
    exit 0
}
wsl.exe --update | Out-Null
wsl.exe --set-default-version 2 | Out-Null

# --- Memoria per WSL: di default WSL usa solo meta' della RAM ---------------
$wslMem = [math]::Max(4, $ramGB - 6)
$wslConfig = Join-Path $env:USERPROFILE ".wslconfig"
Say "Configuro $wslConfig (memoria WSL = $wslMem GB)"
if ((Test-Path $wslConfig) -and -not (Test-Path "$wslConfig.bak")) { Copy-Item $wslConfig "$wslConfig.bak" }
@"
[wsl2]
memory=${wslMem}GB
swap=16GB
"@ | Set-Content -Path $wslConfig -Encoding ASCII
wsl.exe --shutdown

# --- Compilazione dentro Ubuntu ---------------------------------------------
$wslArgs = @()
if ($Cpu)   { $wslArgs += "--cpu" }
if ($Model) { $wslArgs += @("--model", $Model) }
Say "Avvio l'installazione dentro $Distro (ti verra' chiesta la password di Ubuntu)"
# Converte eventuali fine-riga Windows (CRLF) in LF, altrimenti bash fallisce.
$sh = Join-Path $PSScriptRoot "install-ds4-wsl.sh"
$text = [IO.File]::ReadAllText($sh)
if ($text.Contains("`r")) { [IO.File]::WriteAllText($sh, $text.Replace("`r`n", "`n")) }
wsl.exe -d $Distro --cd "$PSScriptRoot" --exec bash install-ds4-wsl.sh @wslArgs
if ($LASTEXITCODE -ne 0) { Warn "Installazione fallita (codice $LASTEXITCODE). Leggi i messaggi sopra."; exit $LASTEXITCODE }

Say "Fatto! Apri 'Ubuntu' dal menu Start, poi:  cd ~/ds4  &&  ./ds4 --help"
