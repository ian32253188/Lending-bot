# Bitfinex Lending Bot

Bitfinex USD Funding 自動放貸工具，提供網頁儀表板、放貸策略、歷史資料與 Telegram 通知。此專案目前是供單一管理員自架使用的應用程式，不是多租戶 SaaS，也不提供 Google OAuth 登入。

## 目前架構

- **帳戶**：每個部署實例只有一組本機管理員登入與一個 Bitfinex 帳戶。
- **放貸幣別**：僅 USD Funding。
- **登入**：使用 `.env` 設定的 `ADMIN_PASSWORD`；伺服器簽發本機 JWT。
- **資料庫**：預設由 Docker Compose 啟動本機 PostgreSQL，資料留在 Docker volume。
- **交易所憑證**：登入儀表板後，到放貸設定輸入 Bitfinex API Key 與 Secret。請只開啟讀取錢包與 Funding 所需的權限，勿開啟提領權限。
- **部署**：GitHub Actions 執行測試、建置映像、推送 GHCR，並透過 SSH 更新自架伺服器。Compose 不包含 Nginx，也不會替網域申請 TLS 憑證。

## 需求

- Docker Engine 與 Docker Compose v2
- GitHub repo 的讀取權限（若從原始碼安裝）
- Bitfinex 帳戶與 API Key

## 快速開始

```bash
git clone https://github.com/ian32253188/Lending-bot.git
cd Lending-bot
cp .env.example .env
```

編輯 `.env`，至少設定以下三個值：

| 設定 | 說明 |
| --- | --- |
| `POSTGRES_PASSWORD` | PostgreSQL 密碼，至少 32 個隨機字元 |
| `ADMIN_PASSWORD` | 儀表板登入密碼，至少 12 個字元 |
| `JWT_SECRET` | 至少 32 個隨機字元，用於登入 Token 與 Bitfinex 憑證加密 |

可用 `openssl rand -hex 32` 產生隨機值；每個設定各產生一份。`.env` 含有私密資料，請勿提交到 Git 或分享。修改 `JWT_SECRET` 會讓先前加密的 Bitfinex 憑證無法解密，變更後需在儀表板重新輸入並儲存 API Key 與 Secret。舊版安裝的範本密鑰不會被接受；`deploy/setup.sh` 會替空白或明顯的範本密鑰產生新值。

啟動開發 Compose：

```bash
cd deploy
docker compose --env-file ../.env -f docker-compose.yml up -d --build
```

開啟 [http://localhost:3000](http://localhost:3000)，以 `ADMIN_PASSWORD` 登入，再到「放貸系統設定」填入 Bitfinex API Key 與 Secret。Telegram 通知為選用功能，可在 `.env` 設定 Bot Token 與 Chat ID。

## 自架正式部署

正式 Compose 使用已建置的 `ghcr.io/ian32253188/lending-bot:latest` 映像。目前 GHCR 不允許匿名拉取；伺服器需使用有套件讀取權限的 GitHub token 登入 GHCR（token 至少需要 `read:packages` 權限）。設定好根目錄 `.env` 後，在 `deploy/` 執行：

```bash
docker login ghcr.io
docker compose --env-file ../.env -f docker-compose.prod.yml pull
docker compose --env-file ../.env -f docker-compose.prod.yml up -d
```

應用程式與 PostgreSQL 都只綁定主機的 loopback。正式對外服務前，請在主機另行設定 TLS 反向代理與防火牆規則；不要直接以未加密 HTTP 對公網提供管理儀表板。`deploy/setup.sh` 可在受支援的 OCI Linux VM 安裝 Docker、產生初始密鑰並啟動服務；它不會設定 Nginx、TLS 或雲端防火牆。

第一次以 `deploy/setup.sh` 安裝時，先用 root 的 Docker 設定登入 GHCR，再執行安裝腳本：

```bash
printf '%s' "$GHCR_TOKEN" | sudo docker login ghcr.io -u "$GITHUB_USERNAME" --password-stdin
sudo bash deploy/setup.sh
```

手動 Compose 指令適用於新的空資料 volume。既有 volume 更新請使用 GitHub Actions 部署流程或 `setup.sh`；它們會同步 PostgreSQL 角色密碼。單獨修改 `.env` 後執行 `docker compose up` 不會更改既有資料庫內的密碼。

GitHub Actions 部署流程需要 repo secrets：`OCI_VM_IP`、`OCI_VM_USER`、`OCI_SSH_PRIVATE_KEY`。部署主機需有專案 checkout 與已設定好的 `.env`，且能讀取 workflow 推送的 GHCR 映像。

目前 GHCR 不允許匿名拉取，手動部署與 `setup.sh` 都需要有 `read:packages` 權限的 GitHub token。使用 `setup.sh` 時必須以 root 的 Docker 設定登入（上方指令）；部署流程會先檢查必要設定，再套用 PostgreSQL 密碼並啟動應用程式。GitHub Actions 會在伺服器 `.env` 缺少資料庫密碼或仍用舊範本時產生隨機值。

## 資料與維護

- 首次建立新的 PostgreSQL volume 時，Compose 會執行 `deploy/init-db/` 中的初始化 SQL。既有 volume 不會重新執行初始化檔。
- PostgreSQL 資料儲存在 `postgres_data` 或 `postgres_dev_data` volume；升級或重建容器前請先備份資料庫及 `.env`。
- 備份正式資料庫（在 `deploy/` 執行，輸出檔寫到專案根目錄）：

  ```bash
  docker compose --env-file ../.env -f docker-compose.prod.yml exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > ../lending-bot-backup.sql
  ```

- 本機開發版重新建置／停止：

  ```bash
  docker compose --env-file ../.env -f docker-compose.yml up -d --build
  docker compose --env-file ../.env -f docker-compose.yml down
  ```

  `down` 會保留資料 volume；移除 volume 會刪除資料，請先確認備份。
- 查看服務記錄：

  ```bash
  cd deploy
  docker compose --env-file ../.env -f docker-compose.prod.yml logs -f
  ```

- 從原始碼執行測試：`npm ci`、`npm ci --prefix client`，再執行 `npm test`。GitHub Actions 也會在部署前執行測試。

## 專案主要目錄

```text
client/                 React 網頁儀表板
server/                 Express API、放貸引擎與 Bitfinex 整合
deploy/docker-compose.yml       開發用 App + PostgreSQL
deploy/docker-compose.prod.yml  正式環境 GHCR image + PostgreSQL
deploy/init-db/         新資料庫初始化 SQL
supabase/               舊版 Supabase 相容／遷移檔案；不是目前主要部署依賴
```

## 授權

本專案以 ISC License 授權，詳見 [LICENSE](LICENSE)。

## 風險聲明

本工具會對 Bitfinex Funding 帳戶執行操作。加密資產放貸可能造成資金損失或無法即時取回資金；使用前請自行審查策略、限制 API 權限並評估風險。本專案不構成投資或財務建議。
