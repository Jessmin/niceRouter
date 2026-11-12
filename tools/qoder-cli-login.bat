@echo off
setlocal
chcp 65001 >nul
title Qoder CLI Login
set "ELECTRON_RUN_AS_NODE=1"
if not defined QODER_EXE set "QODER_EXE=%LOCALAPPDATA%\Programs\Qoder CN\Qoder CN.exe"
if not defined QODER_WORKER set "QODER_WORKER=%LOCALAPPDATA%\Programs\Qoder CN\resources\app.asar.unpacked\node_modules\@qoder-ai\qoder-cn-agent-sdk\dist\_worker\qoder-worker-runtime.obf.mjs"
if not exist "%QODER_EXE%" (
  echo [错误] 找不到 Qoder CN 客户端，请安装或设置 QODER_EXE。
  pause
  exit /b 1
)
if not exist "%QODER_WORKER%" (
  echo [错误] 找不到 Qoder CN CLI worker，请检查安装或设置 QODER_WORKER。
  pause
  exit /b 1
)
echo ==============================================
echo   Qoder CLI 登录（只需一次）
echo   1) 复制下面出现的 https 链接到浏览器打开
echo   2) 用已登录的 Qoder 账号确认授权
echo   3) 本窗口出现 success 即完成
echo ==============================================
echo.
"%QODER_EXE%" "%QODER_WORKER%" login
set "LOGIN_EXIT=%errorlevel%"
if not "%LOGIN_EXIT%"=="0" (
  echo Qoder CLI 登录退出码：%LOGIN_EXIT%
  pause
  exit /b %LOGIN_EXIT%
)
echo.
echo ---------- 登录流程结束 ----------
pause
exit /b 0
