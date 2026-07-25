@echo off
REM host.cmd — cmd.exe wrapper so `bin\host <cmd>` works outside PowerShell.
REM All arguments pass straight through to bin\host.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0host.ps1" %*
