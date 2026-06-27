@echo off
title QR Se Resume - Build Agent EXE
color 0B
echo.
echo  Building QR Se Resume Print Agent EXE...
echo.

pip install pyinstaller pystray pillow requests pywin32 --quiet
echo Packages installed!

pyinstaller build_agent.spec --clean --noconfirm

if exist "dist\QRSeResume_Agent.exe" (
    copy "dist\QRSeResume_Agent.exe" "..\public\downloads\QRSeResume_Agent.exe"
    echo.
    echo  SUCCESS! EXE copied to public/downloads/
) else (
    echo ERROR: Build failed! Check output above.
)
pause
