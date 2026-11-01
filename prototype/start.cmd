@echo off
setlocal
rem Electron 在当前盘可能被执行策略拦截；优先用 C: 上的独立运行时。
set "RUNTIME=%USERPROFILE%\.local\share\rp-pet-electron\electron\electron.exe"
if not exist "%RUNTIME%" set "RUNTIME=%TEMP%\rp-pet-webview\electron-full\electron.exe"
if not exist "%RUNTIME%" set "RUNTIME=%~dp0node_modules\electron\dist\electron.exe"
if not exist "%RUNTIME%" (
  echo 找不到 Electron 运行时。
  echo 请安装 Electron，或把 electron.exe 加入安全软件白名单后运行 npm start。
  pause
  exit /b 1
)
start "" "%RUNTIME%" "%~dp0"
