@echo off
:: Launch the Orchestrator widget window.
:: Assumes the local server is already running (npm start in server/).
:: Double-click in Explorer or run from cmd.

setlocal
set "SCRIPT_DIR=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%start_widget.ps1" %*
endlocal
