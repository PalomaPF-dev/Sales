@echo off
rem Registers the auto import in Windows Task Scheduler (Mon-Fri 12:00).
rem Put auto-import.config.json next to this file, then double-click this file once.
rem It first runs a check (nothing is imported), and registers the task only if the check passes.
setlocal
cd /d "%~dp0"
set "TASK=SalesPricing AutoImport"

if not exist "%~dp0auto-import.config.json" (
  echo [NG] auto-import.config.json was not found in this folder.
  echo      Copy auto-import.config.example.json to auto-import.config.json, fill it in, and run this again.
  goto :fail
)

echo Checking the connection and the folders. Nothing is imported in this step...
call "%~dp0run.cmd" --check
if errorlevel 9009 (
  echo.
  echo [NG] Node.js was not found. Put node.exe in this folder, or install Node.js 22 or later, and run this again.
  goto :fail
)
if errorlevel 1 (
  echo.
  echo [NG] The check above reported a problem. Fix it and run this again.
  echo      See the troubleshooting table at the end of README.md.
  goto :fail
)

echo.
echo Registering the task "%TASK%" to run Mon-Fri at 12:00 as %USERDOMAIN%\%USERNAME%.
echo Enter the Windows password of this user when asked.
echo The password lets the task run even when nobody is logged on.
schtasks /Create /F /TN "%TASK%" /TR "\"%~dp0run.cmd\"" /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 12:00 /RU "%USERDOMAIN%\%USERNAME%" /RP
if errorlevel 1 goto :fail

echo.
echo [OK] Registered. To run it once now: schtasks /Run /TN "%TASK%"
pause
exit /b 0

:fail
pause
exit /b 1
