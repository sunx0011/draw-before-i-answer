@echo off
title DRAW BEFORE I ANSWER server
cd /d "%~dp0"
where node >NUL 2>NUL
if errorlevel 1 (
  echo.
  echo Node.js is not installed. Opening nodejs.org - install the LTS version, then double-click this file again.
  start https://nodejs.org/
  pause
  exit /b
)
if not exist node_modules\ws call npm install
echo.
echo Starting DRAW BEFORE I ANSWER... keep this window open while playing. Close it to stop the game.
start "" http://localhost:3000
node server.js
pause
