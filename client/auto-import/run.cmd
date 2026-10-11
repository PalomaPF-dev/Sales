@echo off
rem Auto import (shipping details / sales) for the sales pricing app.
rem Windows Task Scheduler runs this file on weekdays at noon. See README.md.
setlocal
cd /d "%~dp0"

rem Node.js. node.exe in this folder is used first, so Node.js does not have to be installed
rem (put node.exe from the official zip, node-v22.x.x-win-x64.zip, next to this file).
rem Otherwise the installed Node.js (node on PATH) is used.
set "NODE=node"
if exist "%~dp0node.exe" set "NODE=%~dp0node.exe"

rem If this PC reaches the internet through a proxy, remove "rem" from the next two lines
rem and write the proxy address (needs Node.js 22.21 or later).
rem set "HTTPS_PROXY=http://proxy.example.co.jp:8080"
rem set "NODE_USE_ENV_PROXY=1"

rem If the company network inspects HTTPS with its own certificate,
rem add --use-system-ca after --max-old-space-size=4096 below.
"%NODE%" --max-old-space-size=4096 "%~dp0auto-import.mjs" %*
exit /b %ERRORLEVEL%
