@echo off
echo ============================================
echo   Ouroboros Agent — Installation
echo ============================================
echo.

:: Check Node.js
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Install Node.js 22+ from https://nodejs.org
    pause
    exit /b 1
)
echo [OK] Node.js found

echo.
echo Installing npm dependencies...
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] npm install failed
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Installation complete!
echo.
echo   Start Ouroboros:  npx tsx src/repl.ts
echo   Or link globally:  npm link
echo                      ourob
echo ============================================
pause
