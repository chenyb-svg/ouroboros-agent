@echo off
REM Ouroboros Task Notification
echo.
echo ============================================
echo   Ouroboros Task Complete!
echo   Time: %date% %time%
echo   Message: %*
echo ============================================
echo.
powershell -Command "Add-Type -AssemblyName System.Windows.Forms; $n=New-Object System.Windows.Forms.NotifyIcon; $n.Icon=[System.Drawing.SystemIcons]::Information; $n.Visible=$true; $n.ShowBalloonTip(5000,'Ouroboros','%*','Info')" 2>/dev/null
