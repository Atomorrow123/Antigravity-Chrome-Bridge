@echo off
chcp 65001 >nul
title Antigravity Chrome Bridge Installer
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found in PATH. Please install Node.js ^(https://nodejs.org/^) first.
    pause
    exit /b 1
)
node "%~dp0install.js" %*
echo.
pause
