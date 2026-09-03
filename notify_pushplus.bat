@echo off
REM ============================================
REM PushPlus 微信通知脚本
REM 用法: notify_pushplus.bat "消息标题" "消息内容"
REM ============================================

set TOKEN=%PUSHPLUS_TOKEN%
if "%TOKEN%"=="" (
    echo [错误] 请先设置环境变量 PUSHPLUS_TOKEN
    echo 或者在脚本中直接修改下面的 TOKEN 变量
    set TOKEN=你的Token
)

set TITLE=%~1
set CONTENT=%~2

if "%TITLE%"=="" set TITLE=Ouroboros 通知
if "%CONTENT%"=="" set CONTENT=任务已完成

echo 发送 PushPlus 通知...
echo 标题: %TITLE%
echo 内容: %CONTENT%

curl -s -X POST "https://www.pushplus.plus/send" ^
  -H "Content-Type: application/json" ^
  -d "{\"token\":\"%TOKEN%\",\"title\":\"%TITLE%\",\"content\":\"%CONTENT%\",\"template\":\"txt\"}"

echo.
echo 通知发送完毕！
