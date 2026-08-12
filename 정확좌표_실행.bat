@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==================================================
echo   Address -> exact coordinates
echo   Put your key in ONE of these (then save):
echo     kakao_key.txt   (Kakao REST API key - recommended)
echo     vworld_key.txt  (VWorld key)
echo   Then this runs automatically.
echo ==================================================
echo.
python run_geocode.py
if errorlevel 1 py run_geocode.py
echo.
echo === Done. You can close this window. ===
pause
