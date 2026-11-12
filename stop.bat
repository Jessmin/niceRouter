@echo off
setlocal
call "%~dp0start.bat" --stop
exit /b %ERRORLEVEL%
