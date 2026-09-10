@echo off
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Roda npm install nesta pasta primeiro.
  pause
  exit /b 1
)
start "Jancord" "node_modules\electron\dist\electron.exe" "%~dp0."
