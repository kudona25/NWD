@echo off
setlocal
cd /d "%~dp0"

rem Portable build (tools\make-portable.ps1): Python + packages inside the folder, runs on any PC
set "PY=runtime\python\python.exe"
if exist "%PY%" (
  "%PY%" -c "import uvicorn, fastapi, netmiko" >nul 2>nul
  if not errorlevel 1 goto run
  echo [NWD] runtime\python is broken - falling back to .venv
)
set "PY=.venv\Scripts\python.exe"

rem .venv only works on the PC that created it (it points at that PC's Python).
rem If it was copied from another PC, or is half-installed, rebuild it here.
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" -c "import uvicorn, fastapi, netmiko" >nul 2>nul
  if errorlevel 1 (
    echo [NWD] .venv does not work on this PC ^(copied from another PC?^) - rebuilding...
    rmdir /s /q ".venv"
  )
)

if not exist ".venv\Scripts\python.exe" (
  echo [NWD] Creating Python virtual environment...
  py -3 -m venv .venv 2>nul || python -m venv .venv
  if not exist ".venv\Scripts\python.exe" (
    echo [NWD] Python 3.11+ not found. Install from https://www.python.org/downloads/ and tick "Add to PATH".
    pause
    exit /b 1
  )
)

".venv\Scripts\python.exe" -c "import uvicorn, fastapi, netmiko" >nul 2>nul
if errorlevel 1 (
  echo [NWD] Installing packages - first run only...
  ".venv\Scripts\python.exe" -m pip install --upgrade pip -q
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt -q
  if errorlevel 1 (
    echo.
    echo [NWD] Package install failed. Behind a company proxy? Run this once in cmd, then start.bat again:
    echo        setx HTTPS_PROXY http://proxy-host:port
    pause
    exit /b 1
  )
)

:run
echo [NWD] Open http://127.0.0.1:8000  (close this window to stop)
echo [NWD] Not scanning yet - choose "Scan site" or "Move to new site" on the web page.
start "" http://127.0.0.1:8000
rem -s: ignore the PC's per-user site-packages so nothing installed there can clash
"%PY%" -s -m uvicorn app.main:app --host 127.0.0.1 --port 8000
pause
