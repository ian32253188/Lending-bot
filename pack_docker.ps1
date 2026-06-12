# pack_docker.ps1
# Build local Docker image and export to tar file

Write-Host "=== starting local Docker build ===" -ForegroundColor Cyan
docker build -t ghcr.io/ian32253188/lending-bot:latest .

if ($LASTEXITCODE -ne 0) {
    Write-Error "Docker build failed. Please make sure Docker Desktop is installed and running!"
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "=== Exporting image to lending-bot.tar (this may take a few seconds) ===" -ForegroundColor Cyan
if (Test-Path "lending-bot.tar") {
    Remove-Item "lending-bot.tar" -Force
}
docker save -o lending-bot.tar ghcr.io/ian32253188/lending-bot:latest

if ($LASTEXITCODE -ne 0) {
    Write-Error "Exporting tar file failed!"
    exit $LASTEXITCODE
}

$fileSize = (Get-Item "lending-bot.tar").Length / 1MB
Write-Host ""
Write-Host "Pack successful!" -ForegroundColor Green
Write-Host "File path: " -NoNewline
Write-Host (Resolve-Path "lending-bot.tar") -ForegroundColor Yellow
Write-Host "File size: " -NoNewline
Write-Host ("{0:N2} MB" -f $fileSize) -ForegroundColor Yellow
Write-Host ""
Write-Host "Next, please upload 'lending-bot.tar' and the 'deploy' folder to your server." -ForegroundColor Green
Write-Host "Run the following commands on the server to load and start:" -ForegroundColor Green
Write-Host "  1. Load image: sudo docker load -i lending-bot.tar" -ForegroundColor White
Write-Host "  2. Go to deploy folder: cd deploy" -ForegroundColor White
Write-Host "  3. Start services: sudo docker compose -f docker-compose.prod.yml up -d" -ForegroundColor White
Write-Host ""
