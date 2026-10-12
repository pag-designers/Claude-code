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

REM Find a 64-bit Intel/AMD Python 3.11-3.14 (the speech-recognition package only ships for those on Windows).
set "PYCHECK=import platform,sys; ok = platform.machine().lower() in ('amd64','x86_64') and sys.maxsize.bit_length() == 63 and sys.version_info[:2] in [(3,11),(3,12),(3,13),(3,14)]; sys.exit(0 if ok else 1)"
set "PY="
for %%C in ("py -3.12-64" "py -3.12" "py -3.11-64" "py -3.13-64" "py -3.14-64" "py -3" "python") do (
  if not defined PY (
    %%~C -c "%PYCHECK%" >nul 2>nul && set "PY=%%~C"
  )
)
if not defined PY (
  echo.
  echo No compatible Python found. Clipper needs 64-bit Python 3.12 for Intel/AMD.
  echo Your current Python is probably 32-bit or an ARM build.
  echo   1. Press Start, type cmd, press Enter.
  echo   2. Paste:  winget install Python.Python.3.12 --architecture x64   and press Enter.
  echo   3. When it finishes, double-click run.bat again.
  echo.
  pause & exit /b 1
)
echo Using Python: %PY%

REM A .venv made by an unsupported Python (e.g. from an earlier failed run) can't install the packages: rebuild it.
if exist .venv\Scripts\python.exe (
  .venv\Scripts\python -c "%PYCHECK%" >nul 2>nul || (
    echo Removing the old Python environment ^(it was made with an unsupported Python^)...
    rmdir /s /q .venv
  )
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
