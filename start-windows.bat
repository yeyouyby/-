@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js。请先安装 Node.js 20 LTS: https://nodejs.org/
  pause
  exit /b 1
)

if not exist node_modules (
  echo 正在安装依赖...
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

if "%PORT%"=="" set PORT=3000
if "%HOST%"=="" set HOST=0.0.0.0
echo.
echo Windows 局域网服务即将启动，若防火墙询问请允许专用网络访问。
echo 浏览器访问 http://localhost:%PORT%，同局域网玩家访问终端打印的局域网地址。
echo.
call npm start
pause
