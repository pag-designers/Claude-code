@echo off
REM One-click launcher for Windows: creates the Python env, installs deps, starts the app, opens the browser.
REM Double-click run.bat (first run takes a few minutes; later runs start in seconds).
cd /d "%~dp0"

where py >nul 2>nul && (set "PY=py -3") || (set "PY=python")
%PY% -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)" 2>nul || (
  echo Python 3.11+ not found. Install it with:  winget install Python.Python.3.12
  pause & exit /b 1
)
where ffmpeg >nul 2>nul || (echo ffmpeg not found. Install with:  winget install Gyan.FFmpeg   then reopen this window. & pause & exit /b 1)
where node >nul 2>nul || (echo node not found. Install with:  winget install OpenJS.NodeJS.LTS   then reopen this window. & pause & exit /b 1)

if not exist .venv\Scripts\python.exe (
  echo Creating Python environment ^(.venv^)...
  %PY% -m venv .venv || (pause & exit /b 1)
)
if not exist .venv\.installed (
  echo Installing dependencies ^(first time: 3-5 minutes^)...
  .venv\Scripts\python -m pip install -q --upgrade pip
  .venv\Scripts\pip install -q -r requirements.txt || (pause & exit /b 1)
  type nul > .venv\.installed
)
if not exist .env copy .env.example .env >nul

echo.
echo Clipper is starting at http://localhost:8000  (close this window to stop)
echo Paste your Anthropic API key in Settings (gear icon, top right) the first time.
start "" /b cmd /c "timeout /t 3 >nul & start http://localhost:8000"
.venv\Scripts\uvicorn backend.app.main:app --port 8000
pause
