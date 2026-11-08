@echo off
chcp 65001 >nul
title Antigravity Chrome Bridge Launcher
if exist "%USERPROFILE%\.gemini\config\plugins\antigravity-chrome-bridge\runtime\scripts\install-and-launch.js" (
    node "%USERPROFILE%\.gemini\config\plugins\antigravity-chrome-bridge\runtime\scripts\install-and-launch.js"
) else (
    node "%~dp0antigravity-package\runtime\scripts\install-and-launch.js"
)
echo.
pause
