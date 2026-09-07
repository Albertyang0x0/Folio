@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo [1/3] Creating virtual environment...
  python -m venv .venv
  if errorlevel 1 (
    echo [ERROR] Python not found. Install Python 3.10+ first.
    pause
    exit /b 1
  )
  echo [2/3] Installing dependencies (first run may take a while)...
  ".venv\Scripts\python.exe" -m pip install -U pip -q
  ".venv\Scripts\python.exe" -m pip install -r backend\requirements.txt -q
)
echo [3/3] Starting server: http://127.0.0.1:8000
start "" http://127.0.0.1:8000
".venv\Scripts\python.exe" -m uvicorn main:app --app-dir backend --host 127.0.0.1 --port 8000
pause
