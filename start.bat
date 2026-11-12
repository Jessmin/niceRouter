@echo off
setlocal
cd /d "%~dp0"
if defined NODE_EXE (
  set "NODE_CANDIDATE=%NODE_EXE%"
  call :validate_node
  if errorlevel 1 goto missing_node
  goto run_gateway
)
for /f "delims=" %%N in ('where.exe node.exe 2^>nul') do (
  set "NODE_CANDIDATE=%%N"
  call :validate_node
  if not errorlevel 1 goto run_gateway
)
for %%N in ("%ProgramFiles%\nodejs\node.exe" "%LOCALAPPDATA%\Programs\nodejs\node.exe") do (
  set "NODE_CANDIDATE=%%~N"
  call :validate_node
  if not errorlevel 1 goto run_gateway
)
for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
  set "NODE_CANDIDATE=%%~fD\node.exe"
  call :validate_node
  if not errorlevel 1 goto run_gateway
)
set "NODE_CANDIDATE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
call :validate_node
if errorlevel 1 goto missing_node

:run_gateway
echo Using Node.js: "%NODE_EXE%"
"%NODE_EXE%" --env-file-if-exists=.env tools\start-gateway.mjs "%~1"
set "GATEWAY_EXIT=%ERRORLEVEL%"
if not "%GATEWAY_EXIT%"=="0" if /I not "%~1"=="--stop" pause
exit /b %GATEWAY_EXIT%

:validate_node
"%NODE_CANDIDATE%" -e "const [major,minor]=process.versions.node.split('.').map(Number);process.exit(major>22||major===22&&minor>=9?0:1)" >nul 2>nul
if errorlevel 1 exit /b 1
set "NODE_EXE=%NODE_CANDIDATE%"
exit /b 0

:missing_node
echo No usable Node.js 22.9 or newer was found.
if defined NODE_EXE echo Check the path and version specified by NODE_EXE.
echo Install Node.js and add it to PATH, or set NODE_EXE to its full path.
pause
exit /b 1
