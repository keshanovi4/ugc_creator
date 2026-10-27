@echo off
setlocal
chcp 65001 >nul
set "UGC_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%UGC_NODE%" set "UGC_NODE=node"
"%UGC_NODE%" "%~dp0tools\update-pilot-token.mjs"
pause
