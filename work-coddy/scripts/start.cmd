@echo off
chcp 65001 >nul
title WorkBuddy Live IDE
set "SCRIPTS=%~dp0"
if not "%~1"=="" (set "WB_IDE_ROOT=%~1") else (set "WB_IDE_ROOT=%~dp0..")
if not defined WB_IDE_PORT set "WB_IDE_PORT=6830"
cd /d "%SCRIPTS%"
echo.
echo   WorkBuddy Live IDE
echo   Workspace : %WB_IDE_ROOT%
echo   Pass the workspace path as the first argument if this is not correct.
echo   Open the URL printed below in WorkBuddy Results / Web tab.
echo   Close this window to stop the service.
echo.
node server.mjs
pause
