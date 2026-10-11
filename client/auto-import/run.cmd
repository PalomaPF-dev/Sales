@echo off
rem Auto import (shipping details / sales) for the sales pricing app.
rem Windows Task Scheduler runs this file on weekdays at noon. See README.md.
setlocal
cd /d "%~dp0"

rem Node.js. Change this line if node.exe is not on PATH.
set "NODE=node"
rem set "NODE=C:\Program Files\nodejs\node.exe"

rem If this PC reaches the internet through a proxy, remove "rem" from the next two lines
rem and write the proxy address (needs Node.js 22.21 or later).
rem set "HTTPS_PROXY=http://proxy.example.co.jp:8080"
rem set "NODE_USE_ENV_PROXY=1"

rem If the company network inspects HTTPS with its own certificate,
rem add --use-system-ca after --max-old-space-size=4096 below.
"%NODE%" --max-old-space-size=4096 "%~dp0auto-import.mjs" %*
exit /b %ERRORLEVEL%
