@echo off
title QR Se Resume - Agent Installer
color 0B
cls

echo.
echo  ╔══════════════════════════════════════════════╗
echo  ║     QR Se Resume - Windows Installer         ║
echo  ╚══════════════════════════════════════════════╝
echo.
pause

echo [1/4] Python check...
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Python nahi mila! python.org se install karo
    start https://www.python.org/downloads/
    pause & exit /b 1
)
echo ✅ Python OK!

echo [2/4] Packages install...
python -m pip install requests pywin32 --quiet
echo ✅ Packages ready!

echo [3/4] SumatraPDF check...
if exist "%ProgramFiles%\SumatraPDF\SumatraPDF.exe" (
    echo ✅ SumatraPDF ready!
) else (
    echo Installing SumatraPDF...
    winget install SumatraPDF.SumatraPDF --silent >nul 2>&1
    if %errorlevel% equ 0 (echo ✅ Done!) else (echo ⚠️  Manually install: sumatrapdfreader.org)
)

echo [4/4] Shop ID configure karo
echo.
echo Dashboard (https://qr-se-resume.onrender.com/dashboard) se
echo apna Shop ID copy karke yahan paste karo:
set /p SHOP_ID="Shop ID: "
if "%SHOP_ID%"=="" set SHOP_ID=AAPKA_RSHOP_ID

python -c "
content = open('print_agent.py','r',encoding='utf-8').read()
content = content.replace('AAPKA_RSHOP_ID','%SHOP_ID%')
open('print_agent.py','w',encoding='utf-8').write(content)
print('✅ Shop ID updated!')
"

echo @echo off > RUN_AGENT.bat
echo title QR Se Resume Agent >> RUN_AGENT.bat
echo cd /d "%%~dp0" >> RUN_AGENT.bat
echo python print_agent.py >> RUN_AGENT.bat
echo pause >> RUN_AGENT.bat

choice /c YN /m "Startup mein auto-start add karo?"
if %errorlevel% equ 1 (
    echo @echo off > "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\QRSeResume.bat"
    echo cd /d "%~dp0" >> "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\QRSeResume.bat"
    echo python print_agent.py >> "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\QRSeResume.bat"
    echo ✅ Startup mein add ho gaya!
)

echo.
echo ╔══════════════════════════════════════════════╗
echo ║        ✅ SETUP COMPLETE!                    ║
echo ║   RUN_AGENT.bat se agent start karo          ║
echo ╚══════════════════════════════════════════════╝
echo.
choice /c YN /m "Abhi agent start karo?"
if %errorlevel% equ 1 python print_agent.py
pause
