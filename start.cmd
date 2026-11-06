@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required for local preview. GitHub Pages does not need Node.js.
  pause
  exit /b 1
)
start "" http://127.0.0.1:8127
node serve.cjs
pause
