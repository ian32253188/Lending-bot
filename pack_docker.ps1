# pack_docker.ps1
# 自動建置本機 Docker 映像檔並匯出為 tar 封裝檔

Write-Host "=== 🐳 開始建置本地 Docker 映像檔 ===" -ForegroundColor Cyan
docker build -t ghcr.io/ian32253188/lending-bot:latest .

if ($LASTEXITCODE -ne 0) {
    Write-Error "Docker 建置失敗，請確保本機已安裝且啟動 Docker Desktop！"
    exit $LASTEXITCODE
}

Write-Host "`n=== 📦 正在將映像檔匯出為 lending-bot.tar (這可能需要數十秒) ===" -ForegroundColor Cyan
if (Test-Path "lending-bot.tar") {
    Remove-Item "lending-bot.tar" -Force
}
docker save -o lending-bot.tar ghcr.io/ian32253188/lending-bot:latest

if ($LASTEXITCODE -ne 0) {
    Write-Error "匯出 tar 檔失敗！"
    exit $LASTEXITCODE
}

$fileSize = (Get-Item "lending-bot.tar").Length / 1MB
Write-Host "`n✅ 打包成功！" -ForegroundColor Green
Write-Host "檔案路徑: " -NoNewline
Write-Host (Resolve-Path "lending-bot.tar") -ForegroundColor Yellow
Write-Host "檔案大小: " -NoNewline
Write-Host ("{0:N2} MB" -f $fileSize) -ForegroundColor Yellow
Write-Host "`n💡 接下來，請使用 WinSCP / FileZilla 將 `lending-bot.tar` 與專案中的 `deploy` 資料夾上傳到伺服器。" -ForegroundColor Green
Write-Host "並在伺服器上執行以下指令載入並啟動：" -ForegroundColor Green
Write-Host "  1. 載入映像檔：sudo docker load -i lending-bot.tar" -ForegroundColor White
Write-Host "  2. 進入部署目錄：cd deploy" -ForegroundColor White
Write-Host "  3. 啟動服務：sudo docker compose -f docker-compose.prod.yml up -d`n" -ForegroundColor White

