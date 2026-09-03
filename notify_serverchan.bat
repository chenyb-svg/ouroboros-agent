@echo off
REM ============================================
REM Server酱 微信通知脚本
REM 用法: notify_serverchan.bat "消息标题" "消息内容"
REM 需要先到 https://sct.ftqq.com 注册获取 SendKey
REM ============================================

set SENDKEY=%SERVERCHAN_SENDKEY%
if "%SENDKEY%"=="" (
    echo [错误] 请先设置环境变量 SERVERCHAN_SENDKEY
    echo 或者在脚本中直接修改下面的 SENDKEY 变量
    set SENDKEY=你的SendKey
)

set TITLE=%~1
set CONTENT=%~2

if "%TITLE%"=="" set TITLE=Ouroboros 通知
if "%CONTENT%"=="" set CONTENT=任务已完成

echo 发送 Server酱 通知...
echo 标题: %TITLE%

curl -s -X POST "https://sctapi.ftqq.com/%SENDKEY%.send" ^
  -H "Content-Type: application/json" ^
  -d "{\"title\":\"%TITLE%\",\"content\":\"%CONTENT%\"}"

echo.
echo 通知发送完毕！
