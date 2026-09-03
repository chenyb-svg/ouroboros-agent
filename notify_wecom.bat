@echo off
REM ============================================
REM 企业微信机器人 Webhook 通知脚本
REM 用法: notify_wecom.bat "消息内容"
REM 需要先创建一个企业微信群机器人，获取 Webhook URL
REM ============================================

set WEBHOOK=%WECOM_WEBHOOK%
if "%WEBHOOK%"=="" (
    echo [错误] 请先设置环境变量 WECOM_WEBHOOK
    echo 或者在脚本中直接修改下面的 WEBHOOK_URL 变量
    set WEBHOOK=你的Webhook地址
)

set CONTENT=%~1
if "%CONTENT%"=="" set CONTENT=Ouroboros 任务已完成 ✅

echo 发送企业微信通知...
echo 内容: %CONTENT%

curl -s -X POST "%WEBHOOK%" ^
  -H "Content-Type: application/json" ^
  -d "{\"msgtype\":\"text\",\"text\":{\"content\":\"%CONTENT%\"}}"

echo.
echo 通知发送完毕！
