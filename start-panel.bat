@echo off
echo ==============================================
echo   Starting Snapshot Recovery Web Console...
echo ==============================================
echo.

:: Launch Node.js server in a separate console window
start "Snapshot Recovery Server" node server.js

:: Wait 1.5 seconds for server to start
timeout /t 2 /nobreak >nul

:: Open browser
echo Opening console page in browser...
start http://localhost:3050

echo Launch complete!
exit
