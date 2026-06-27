@echo off
title QR Se Resume - Agent Setup
color 0A
cls
echo.
echo  ╔══════════════════════════════════════════════════╗
echo  ║       QR Se Resume - Print Agent Setup           ║
echo  ╚══════════════════════════════════════════════════╝
echo.
echo  Is setup se ek .exe file banegi jo:
echo  - System tray mein rahegi (neeche right corner)
echo  - PC restart hone par automatically start hogi
echo  - Khud update hogi - kuch manually karna nahi
echo.
pause

:: Check Python
echo [1/5] Python check...
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  Python nahi mila!
    echo  Abhi python.org/downloads pe jao aur install karo
    echo  IMPORTANT: Install karte waqt "Add Python to PATH" tick karo!
    echo.
    start https://www.python.org/ftp/python/3.12.0/python-3.12.0-amd64.exe
    echo  Download shuru ho gaya. Install karne ke baad ye file dobara run karo.
    pause
    exit /b 1
)
echo  Python OK!

:: Check SumatraPDF
echo [2/5] SumatraPDF check...
if exist "%ProgramFiles%\SumatraPDF\SumatraPDF.exe" (
    echo  SumatraPDF already installed!
    goto :sumatra_ok
)
echo.
echo  SumatraPDF nahi mila!
echo  Abhi sumatrapdfreader.org pe jao aur install karo
echo  YA Google mein "SumatraPDF download" search karo
echo.
echo  NOTE: Agar download mein time lag raha hai to
echo  manually download karo aur install karo, phir
echo  DOBARA ye INSTALL.bat run karo.
echo.
start https://www.sumatrapdfreader.org/dl/rel/3.5.2/SumatraPDF-3.5.2-64-install.exe
echo  Download shuru ho gaya. Install karne ke baad ENTER dabao.
pause

if not exist "%ProgramFiles%\SumatraPDF\SumatraPDF.exe" (
    echo  SumatraPDF still not found. Manually install karo phir dobara run karo.
    pause
    exit /b 1
)
:sumatra_ok
echo  SumatraPDF OK!

:: Install Python packages
echo [3/5] Required packages install ho rahe hain...
python -m pip install requests pywin32 pystray pillow pyinstaller --quiet --upgrade
if %errorlevel% neq 0 (
    echo  Package install failed! Internet check karo.
    pause
    exit /b 1
)
echo  Packages OK!

:: Build EXE
echo [4/5] Agent EXE build ho raha hai (1-2 minute lagega)...
if not exist "agent_tray.py" (
    echo  agent_tray.py nahi mila! Sab files ek folder mein honi chahiye.
    pause
    exit /b 1
)

pyinstaller --onefile --noconsole --name "QRSeResume_Agent" ^
    --hidden-import win32print --hidden-import win32api ^
    --hidden-import pystray --hidden-import PIL ^
    --hidden-import requests --hidden-import winreg ^
    agent_tray.py --clean --noconfirm >nul 2>&1

if not exist "dist\QRSeResume_Agent.exe" (
    echo  Build failed! Error check karo.
    pyinstaller --onefile --noconsole --name "QRSeResume_Agent" agent_tray.py --clean
    pause
    exit /b 1
)
echo  EXE build ho gaya!

:: Add to startup
echo [5/5] Windows startup mein add ho raha hai...
set EXE_PATH=%~dp0dist\QRSeResume_Agent.exe
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "QRSeResume" /t REG_SZ /d "%EXE_PATH%" /f >nul
echo  Startup mein add ho gaya!

:: Run it now
echo.
echo  ╔══════════════════════════════════════════════════╗
echo  ║            ✅ SETUP COMPLETE!                    ║
echo  ║                                                  ║
echo  ║  Agent system tray mein start ho raha hai...     ║
echo  ║  Neeche right corner mein icon dikhega           ║
echo  ╚══════════════════════════════════════════════════╝
echo.
start "" "%~dp0dist\QRSeResume_Agent.exe"
echo  Agent start ho gaya! Tray mein dekho (^) arrow ke paas.
echo.
pause
