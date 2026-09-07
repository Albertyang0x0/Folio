@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo [ERROR] Virtual environment not found.
  echo Run start.bat once to create it, then retry.
  pause
  exit /b 1
)
echo Starting dev server ...
echo Open your browser at: http://127.0.0.1:8765
echo Close this window to stop.
start "" http://127.0.0.1:8765
".venv\Scripts\python.exe" -m uvicorn main:app --app-dir backend --host 127.0.0.1 --port 8765
pause
