@echo off
powershell -ExecutionPolicy Bypass -File "%~dp0stop-remotecodex.ps1" %*
