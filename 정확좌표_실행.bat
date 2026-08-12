@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==================================================
echo   Address -> exact coordinates (VWorld)
echo   1) Put your key in  vworld_key.txt
echo   2) This runs automatically. Please wait ~20 min.
echo ==================================================
echo.
python run_geocode.py
if errorlevel 1 py run_geocode.py
echo.
echo === Done. You can close this window. ===
pause
