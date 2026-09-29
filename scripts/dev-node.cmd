@echo off
rem Windows 10/11 entry point for Task and cmd.exe. PowerShell 5.1 is built in.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0dev-node.ps1" %*
exit /b %ERRORLEVEL%
