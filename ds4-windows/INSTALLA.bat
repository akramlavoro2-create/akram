@echo off
REM Doppio clic per installare DwarfStar. Chiede i permessi di amministratore.
net session >nul 2>&1
if %errorlevel% neq 0 (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-ds4-windows.ps1" %*
pause
