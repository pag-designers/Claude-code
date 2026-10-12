@echo off
REM One-click launcher for Windows: creates the Python env, installs deps, starts the app, opens the browser.
REM Double-click run.bat (first run takes a few minutes; later runs start in seconds).
cd /d "%~dp0"

REM run.bat must sit inside the full Clipper folder (next to requirements.txt and the backend folder).
if not exist requirements.txt goto :notinfolder
if not exist backend\app\main.py goto :notinfolder

REM Tools installed with winget after Explorer started aren't on this window's PATH yet.
REM Re-read PATH from the registry and add winget's usual folders, so no restart is needed.
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"`) do set "PATH=%%P;%PATH%"
set "PATH=%PATH%;%LOCALAPPDATA%\Microsoft\WinGet\Links;%ProgramFiles%\nodejs"
for /d %%D in ("%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*") do for /d %%E in ("%%D\ffmpeg-*") do call :addpath "%%E\bin"
for /d %%E in ("C:\ffmpeg*") do call :addpath "%%E\bin"

where py >nul 2>nul && (set "PY=py -3") || (set "PY=python")
%PY% -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)" 2>nul || (
  echo Python 3.11+ not found. Install it with:  winget install Python.Python.3.12
  pause & exit /b 1
)
where ffmpeg >nul 2>nul || (
  echo.
  echo FFmpeg was not found.
  echo   1. Press Start, type cmd, press Enter.
  echo   2. Paste:  winget install Gyan.FFmpeg   and press Enter. Say Y if asked.
  echo   3. When it says "Successfully installed", double-click run.bat again.
  echo   Still failing after that? Restart your computer once, then run.bat again.
  echo.
  pause & exit /b 1
)
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
exit /b

:addpath
if exist "%~1\ffmpeg.exe" set "PATH=%PATH%;%~1"
exit /b

:notinfolder
echo.
echo run.bat is not inside the full Clipper folder, so it can't find the app's files.
echo   1. If you opened the ZIP by double-clicking it: close this window, right-click the ZIP,
echo      choose "Extract All...", then open the extracted folder and double-click run.bat there.
echo   2. Otherwise download the whole app again: github.com/pag-designers/Claude-code
echo      switch the branch to claude/eager-ptolemy-aaxhn3, then Code - Download ZIP, then Extract All.
echo   The folder with run.bat must also contain: requirements.txt, backend, frontend.
echo.
echo This window is running from: %CD%
echo.
pause
exit /b 1
