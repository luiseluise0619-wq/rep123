@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==================================================
echo   Merge gimi9 coordinates into the map
echo   1) Save gimi9 table (WITH address) as  gimi9결과.txt
echo   2) This merges + rebuilds maps automatically.
echo ==================================================
echo.
python gimi9_병합.py
if errorlevel 1 py gimi9_병합.py
echo.
echo === Done. Check 확인필요_목록.html ===
pause
