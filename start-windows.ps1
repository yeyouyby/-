$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "未检测到 Node.js。请先安装 Node.js 20 LTS: https://nodejs.org/" -ForegroundColor Red
  Read-Host "按 Enter 退出"
  exit 1
}

if (-not (Test-Path -LiteralPath "node_modules")) {
  Write-Host "正在安装依赖..."
  npm install
  if ($LASTEXITCODE -ne 0) {
    throw "npm install 失败，退出代码：$LASTEXITCODE"
  }
}

if (-not $env:PORT) { $env:PORT = "3000" }
if (-not $env:HOST) { $env:HOST = "0.0.0.0" }

Write-Host ""
Write-Host "Windows 局域网服务即将启动，若防火墙询问请允许专用网络访问。" -ForegroundColor Yellow
Write-Host "浏览器访问 http://localhost:$env:PORT，同局域网玩家访问终端打印的局域网地址。"
Write-Host ""
npm start
if ($LASTEXITCODE -ne 0) {
  throw "游戏服务异常退出，退出代码：$LASTEXITCODE"
}
