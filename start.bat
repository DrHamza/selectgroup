@echo off
chcp 65001 >nul
title منصة المجموعات والتكليفات الأكاديمية

echo ==========================================================
echo    منصة المجموعات والتكليفات الأكاديمية للطلاب والمعلم
echo ==========================================================
echo.

set NODE_EXE=node
where node >nul 2>nul
if %errorlevel% neq 0 (
    if exist "%LOCALAPPDATA%\ms-playwright-go\1.50.1\node.exe" (
        set "NODE_EXE=%LOCALAPPDATA%\ms-playwright-go\1.50.1\node.exe"
    )
)

echo [✓] تشغيل الخادم...
echo [✓] الرابط: http://localhost:3000
echo.

start "" http://localhost:3000
"%NODE_EXE%" server.js

pause
