@echo off
REM One-click launcher for Windows: updates, creates the Python env, installs deps, starts the app, opens the browser.
REM Double-click run.bat (first run takes a few minutes; later runs start in seconds).
cd /d "%~dp0"
set "SELF=%~f0"

REM run.bat must sit inside the full Clipper folder (next to requirements.txt and the backend folder).
if not exist requirements.txt goto :notinfolder
if not exist backend\app\main.py goto :notinfolder

REM Already running (maybe an older copy in another black window)? Starting a second one would fail.
netstat -ano | findstr /r /c:":8000 .*LISTENING" >nul && goto :alreadyrunning

REM Tools installed with winget after Explorer started aren't on this window's PATH yet.
REM Re-read PATH from the registry and add winget's usual folders, so no restart is needed.
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"`) do set "PATH=%%P;%PATH%"
set "PATH=%PATH%;%LOCALAPPDATA%\Microsoft\WinGet\Links;%ProgramFiles%\nodejs;%ProgramFiles%\Git\cmd"
for /d %%D in ("%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*") do for /d %%E in ("%%D\ffmpeg-*") do call :addpath "%%E\bin"
for /d %%E in ("C:\ffmpeg*") do call :addpath "%%E\bin"

REM Auto-update: if this folder came from "git clone", get the newest version first.
REM Your videos, clips, exports and API key (data, output, .env) are never touched by this.
if exist .git (
  where git >nul 2>nul && call :update
)

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

REM Some video/AI libraries can't open files in folders with accents (e.g. C:\Users\Jose with an accent).
%PY% -c "import os,sys; sys.exit(0 if os.getcwd().isascii() else 1)" || goto :badpath

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
where node >nul 2>nul || (echo node not found. Install with:  winget install OpenJS.NodeJS.LTS   then double-click run.bat again. & pause & exit /b 1)

REM A .venv made by an unsupported Python (e.g. from an earlier failed run) can't install the packages: rebuild it.
if exist .venv\Scripts\python.exe (
  .venv\Scripts\python -c "%PYCHECK%" >nul 2>nul || (
    echo Removing the old Python environment ^(it was made with an unsupported Python^)...
    rmdir /s /q .venv
  )
)
if not exist .venv\Scripts\python.exe (
  echo Creating Python environment ^(.venv^)...
  %PY% -m venv .venv || (pause & exit /b 1)
)

REM Install packages on first run, and again whenever requirements.txt changes after an update.
REM Always "python -m ...": pip.exe/uvicorn.exe break if the Clipper folder is moved or renamed.
fc /b requirements.txt .venv\requirements.installed >nul 2>nul || (
  echo Installing dependencies ^(first time: 3-5 minutes; after updates: usually under a minute^)...
  .venv\Scripts\python -m pip install -q --upgrade pip
  .venv\Scripts\python -m pip install -q -r requirements.txt || (pause & exit /b 1)
  copy /y requirements.txt .venv\requirements.installed >nul
)
REM YouTube changes often and old downloaders stop working: keep yt-dlp fresh (a few seconds; skipped offline).
echo Updating the YouTube downloader...
.venv\Scripts\python -m pip install -q -U "yt-dlp[default]" >nul 2>nul

REM The speech-recognition engine needs Microsoft's Visual C++ runtime (most PCs have it; some don't).
.venv\Scripts\python -c "import ctranslate2, onnxruntime" >nul 2>nul || (
  echo.
  echo One Microsoft component is missing ^(Visual C++ runtime^).
  echo   1. Press Start, type cmd, press Enter.
  echo   2. Paste:  winget install Microsoft.VCRedist.2015+.x64   and press Enter.
  echo   3. Double-click run.bat again.
  echo.
  pause & exit /b 1
)
if not exist .env copy .env.example .env >nul

echo.
echo Clipper is starting at http://localhost:8000  (close this window to stop)
echo Keep this window open while you use Clipper. The first time, paste your API key in Settings.
REM Open the browser as soon as the app answers (not after a fixed wait: antivirus can slow the first start).
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 120;$i++){try{Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 http://127.0.0.1:8000/api/config | Out-Null; Start-Process 'http://localhost:8000'; break}catch{Start-Sleep -Milliseconds 500}}"
.venv\Scripts\python -m uvicorn backend.app.main:app --port 8000 --no-access-log
pause
exit /b

:update
REM The whole block below is read by cmd before git runs. That matters: git pull may replace this very file,
REM and cmd would otherwise keep reading the new file at the old position and run garbage.
echo Checking for updates...
for /f %%H in ('git rev-parse HEAD') do set "OLDHEAD=%%H"
(
  git pull --ff-only --quiet || echo Could not update right now ^(offline, or files in this folder were changed^) - starting the version you have.
  for /f %%H in ('git rev-parse HEAD') do if not "%%H"=="%OLDHEAD%" (
    echo Updated to the newest version - restarting...
    start "" cmd /c call "%SELF%"
    exit
  )
  exit /b
)

:addpath
if exist "%~1\ffmpeg.exe" set "PATH=%PATH%;%~1"
exit /b

:alreadyrunning
echo.
echo Clipper is already running in another black window ^(maybe an older copy^).
echo Opening it in your browser. To restart Clipper: close the other black window, then double-click run.bat again.
echo.
start "" http://localhost:8000
pause
exit /b

:badpath
REM Kept outside any ( ) block: the folder path itself may contain parentheses.
echo.
echo This folder's path has accents or special letters:
echo %CD%
echo Some of Clipper's video tools can't work there. Move the whole Clipper folder to C:\Clipper
echo (or another path with only plain letters), then double-click run.bat there.
echo.
pause
exit /b 1

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
