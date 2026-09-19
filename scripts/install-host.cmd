@echo off
setlocal
rem The PowerShell script prompts for the recorder IP when -Device is omitted.
cd /d "%~dp0"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-host.ps1" %*
set "result=%errorlevel%"
if not "%result%"=="0" echo Installation failed. Please read the error above.
pause
exit /b %result%
