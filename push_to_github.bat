@echo off
chcp 65001 > nul
echo ===================================================
echo   جاري رفع المشروع إلى GitHub: DrHamza/selectgroup
echo ===================================================
echo.
cd /d "%~dp0"
git push -u origin main
echo.
if %ERRORLEVEL% EQU 0 (
    echo [OK] تم رفع المشروع بنجاح إلى GitHub!
) else (
    echo [X] حدث خطأ أثناء الرفع، تأكد من تسجيل الدخول بحسابك في النافذة المنبثقة.
)
echo.
pause
