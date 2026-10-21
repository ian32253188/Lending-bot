# Bitfinex Lending Bot

Bitfinex USD Funding 自動放貸工具，提供網頁儀表板、放貸策略、歷史資料與 Telegram 通知。此專案目前是供單一管理員自架使用的應用程式，不是多租戶 SaaS，也不提供 Google OAuth 登入。

## 目前架構

- **帳戶**：每個部署實例只有一組本機管理員登入與一個 Bitfinex 帳戶。
- **放貸幣別**：僅 USD Funding。
- **登入**：使用 `.env` 設定的 `ADMIN_PASSWORD`；伺服器簽發本機 JWT。
- **資料庫**：預設由 Docker Compose 啟動本機 PostgreSQL，資料留在 Docker volume。
- **交易所憑證**：登入儀表板後，到放貸設定輸入 Bitfinex API Key 與 Secret。檢視帳戶需要 Wallets 與 Funding 讀取權限；建立或取消放貸掛單需要 Funding 寫入權限。若使用內建的錢包間轉帳功能，還需要 Wallets 寫入權限；程式不提供提領或轉至其他帳戶的功能，請勿開啟 Withdrawal 權限。請參閱 [Bitfinex API Key 權限說明](https://docs.bitfinex.com/reference/key-permissions)與[錢包間轉帳 API](https://docs.bitfinex.com/reference/rest-auth-transfer)。
- **部署**：GitHub Actions 執行測試、建置映像、推送 GHCR，並透過 SSH 更新自架伺服器。Compose 不包含 Nginx，也不會替網域申請 TLS 憑證。

## 需求

- Linux 伺服器；以下正式部署步驟以 Ubuntu Server、Docker Compose v2、Nginx 與 Certbot 為例。
- 本機執行完整測試或建置需要 Node.js 22.12 或更新版本；Docker 部署會使用專案映像內指定的 Node.js 版本。
- 一個指向伺服器的網域名稱。DNS 的 A 記錄須指向伺服器 IPv4；只有在 IPv6 可連通時才設定 AAAA 記錄。
- 雲端防火牆只對外開放 SSH（建議限制來源）、TCP 80 與 TCP 443。不要對公網開放應用程式的 3000 埠或 PostgreSQL 的 5432 埠。
- Bitfinex 帳戶與 API Key；請只授予放貸所需權限，絕不可開啟提領權限。

## 快速開始（本機開發）

```bash
git clone https://github.com/ian32253188/Lending-bot.git
cd Lending-bot
cp .env.example .env
nano .env
```

在 `.env` 設定 `POSTGRES_PASSWORD`、`ADMIN_PASSWORD` 與 `JWT_SECRET`。每一項都請用 `openssl rand -hex 32` 各產生一個不同的值。管理員密碼要妥善存入密碼管理器；不要把密鑰、含密鑰的終端機截圖或 `.env` 提交到 GitHub。更換 `JWT_SECRET` 會使登入中的 JWT 失效，並使既有加密的 Bitfinex 與 Telegram 憑證無法解密，屆時須在儀表板重新輸入並儲存。若自行設定 `ENCRYPTION_SALT`，也要一併備份並保持不變。

```bash
cd deploy
docker compose --env-file ../.env -f docker-compose.yml up -d --build
```

開啟 [http://localhost:3000](http://localhost:3000)，以 `ADMIN_PASSWORD` 登入，再到「放貸系統設定」輸入 Bitfinex API Key 與 Secret。`TELEGRAM_BOT_TOKEN` 與 `TELEGRAM_CHAT_ID` 為選用設定；Telegram 僅接受私人對話，並驗證發訊者與已綁定 Chat ID 相同。

## 正式自架部署（Ubuntu、Docker Compose、Nginx）

以下流程會從公開 GitHub 原始碼在伺服器本機建置容器映像，不需要 GHCR 存取權或個人 GitHub Token。正式 Compose 預設只把應用程式與資料庫綁定至伺服器的 loopback；Nginx 負責 HTTPS、WebSocket 連線數限制與登入端點的速率限制。

### 1. 設定 DNS 與防火牆

先將網域 A 記錄設為伺服器 IPv4 位址。若伺服器有正確設定的 IPv6 網路，再設定 AAAA 記錄。於雲端管理介面和主機防火牆只開放 SSH、TCP 80 與 TCP 443；SSH 請限制為管理者的來源 IP。不要建立 3000 或 5432 的公網入站規則。

### 2. 安裝 Docker、Nginx 與 Certbot

以 Docker 官方 Ubuntu apt repository 安裝 Docker Engine 與 Compose plugin。指令會依伺服器的 Ubuntu 版本及 CPU 架構選取套件：

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git nginx openssl snapd
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "$VERSION_CODENAME")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker nginx
sudo docker version
sudo docker compose version
```

Certbot 官方建議以 Snap 安裝。`snapd` 若已安裝，執行：

```bash
sudo systemctl enable --now snapd.socket
sudo snap install --classic certbot
```

若 `/usr/local/bin/certbot` 尚不存在，建立命令連結：

```bash
sudo ln -s /snap/bin/certbot /usr/local/bin/certbot
```

### 3. 下載專案並建立私密設定

```bash
sudo mkdir -p /opt/lending-bot
sudo chown "$USER":"$USER" /opt/lending-bot
git clone https://github.com/ian32253188/Lending-bot.git /opt/lending-bot
cd /opt/lending-bot
umask 077
cp .env.example .env
chmod 600 .env
```

開啟 `.env`，設定三個必要值：

| 設定 | 建議值 |
| --- | --- |
| `POSTGRES_PASSWORD` | 以 `openssl rand -hex 32` 產生的隨機值 |
| `ADMIN_PASSWORD` | 以 `openssl rand -hex 32` 產生的管理員密碼，並存入密碼管理器 |
| `JWT_SECRET` | 另一個獨立的 `openssl rand -hex 32` 隨機值 |

在伺服器執行三次 `openssl rand -hex 32`，把三個不同輸出分別填入表格的欄位，並把管理員密碼存入密碼管理器：

```bash
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 32
nano .env
```

儲存後執行 `chmod 600 .env`。Bitfinex API Key 與 Secret 請留白，第一次登入儀表板後再輸入；這樣便不必把交易所憑證放進部署指令或公開文件。Telegram 欄位可留白。

`.env` 必須只放在伺服器，不得上傳到 GitHub、貼入 issue、聊天或部署日誌。Git ignore 會忽略 `.env.*` mode 檔，並保留 `.env.example` 範本。Git ignore 只能阻止新檔案被追蹤，不能移除曾經進入 Git 歷史的密鑰；任何曾公開的真實憑證都應立即撤銷並重新產生。公開前要掃描目前檔案與完整 Git 歷史。GitHub 會對公開 repository 執行 Secret Scanning；也請在 Security and quality 設定確認 Secret Scanning alerts 與 Push Protection 已啟用，並檢查歷史告警。[GitHub Secret Scanning 說明](https://docs.github.com/en/code-security/concepts/secret-security/secret-scanning)與[啟用 Push Protection](https://docs.github.com/en/code-security/how-tos/secure-your-secrets/prevent-future-leaks/enable-push-protection)。完成部署前，可在專案目錄確認 `.env` 被忽略且未被追蹤：

```bash
git check-ignore -v .env
git ls-files -- .env
git status --short
```

第二個指令應沒有輸出；若列出 `.env`，先移除 Git 追蹤並檢查所有歷史版本，再公開專案。

`JWT_SECRET` 也用於加密儲存在資料庫中的 Bitfinex 憑證與 Telegram Bot Token。請在受控的加密備份中保存 `.env`，並與資料庫備份分開保管；遺失或更換 `JWT_SECRET`（或自行設定的 `ENCRYPTION_SALT`）後，需在設定頁重新輸入 Bitfinex API Key、Secret 與 Telegram Bot Token。舊版 PostgreSQL 啟動時，以及舊版 Supabase 帳戶設定被讀寫前，程式會檢查並加密歷史憑證；搬遷腳本也會先加密回存 Supabase 來源，再寫入 PostgreSQL。新版 Supabase 相容／搬遷程式會以受限 RPC 在 POST body 執行憑證 compare-and-set，避免把舊憑證放進 API URL 與服務日誌；升級舊版 Supabase 時，請先套用 `supabase/migrations/013_secure_credential_migration.sql`，並確認使用具有該 RPC 執行權限的 service-role key。遠端 `SUPABASE_URL` 必須使用 HTTPS；只有本機 loopback 開發服務可使用 HTTP。Supabase runtime fallback 需要讀寫 `user_bot_settings` 的權限。舊備份仍可能含明文憑證，請限制存取並加密保管；確認新部署可解密憑證後，再依備份保留政策安全清除舊副本。搬遷前必須使用來源服務相同的 `JWT_SECRET` 與 `ENCRYPTION_SALT`。

若使用外部 PostgreSQL，應設定 `DATABASE_URL`；應用程式、資料搬遷腳本與研究訓練器都會強制使用 `sslmode=verify-full`。若以 `PGHOST`／`POSTGRES_HOST` 連線，只有 loopback 預設免 TLS；短名 `postgres` 只有在本文件的 Compose 設定明確啟用 `LENDING_BOT_ALLOW_PLAINTEXT_COMPOSE_POSTGRES=1` 時才免 TLS。此旗標只適用於同一個私有 Compose 網路中的內部資料庫服務；外部資料庫請移除旗標並使用 `DATABASE_URL` 或讓 `PGHOST` 使用驗證 TLS。不要用 `sslmode=disable` 繞過驗證。Compose PostgreSQL 使用私有網路，不會對公網開放。

### 4. 建置並啟動應用程式

正式 Compose 設定同時支援維護者使用 GHCR 映像，以及一般使用者由原始碼建置。從原始碼部署請執行 `--build`：

```bash
cd /opt/lending-bot/deploy
sudo docker compose --env-file ../.env -f docker-compose.prod.yml up -d --build
sudo docker compose --env-file ../.env -f docker-compose.prod.yml ps
sudo curl --fail http://127.0.0.1:3000/api/health
```

確認 PostgreSQL 與應用程式都已啟動，且健康檢查回應正常。此時服務仍只在主機本機可連線，先不要直接開放應用程式埠給網際網路。

### 5. 設定 HTTPS、WebSocket 與登入節流

以下範例以 `bot.example.com` 為例。先把所有出現的網域替換成自己的網域。建立暫時的 HTTP site，讓 Certbot 能驗證網域；此設定不代理登入頁：

```bash
sudo tee /etc/nginx/sites-available/lending-bot >/dev/null <<'NGINX'
server {
    listen 80;
    listen [::]:80;
    server_name bot.example.com;
    location / { return 404; }
}
NGINX

sudo ln -s /etc/nginx/sites-available/lending-bot /etc/nginx/sites-enabled/lending-bot
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d bot.example.com --redirect
```

Certbot 成功簽發憑證後，設定 WebSocket 標頭對應與每 IP 登入速率限制：

```bash
sudo tee /etc/nginx/conf.d/lending-bot-security.conf >/dev/null <<'NGINX'
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}
limit_req_zone $binary_remote_addr zone=lendingbot_login:10m rate=10r/m;
limit_conn_zone $binary_remote_addr zone=lendingbot_ws:10m;
NGINX
```

將 site 設定替換成正式 HTTPS 反向代理：

```bash
sudo tee /etc/nginx/sites-available/lending-bot >/dev/null <<'NGINX'
server {
    listen 80;
    listen [::]:80;
    server_name bot.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name bot.example.com;

    ssl_certificate /etc/letsencrypt/live/bot.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bot.example.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    location = /api/auth/login {
        limit_req zone=lendingbot_login burst=5 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
    }

    location /ws {
        limit_conn lendingbot_ws 10;
        limit_conn_status 429;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
NGINX

sudo nginx -t
sudo systemctl reload nginx
sudo certbot renew --dry-run
```

Nginx 範例對每個來源 IP 限制登入速率為每分鐘 10 次，並容許 5 次短暫突增；超出時會回傳 HTTP 429。`/ws` 每個來源 IP 同時最多 10 條連線；應用程式另將全部 WebSocket 連線上限設為 100 條、訊息大小設為 16 KiB，並在 5 秒內未完成認證時關閉連線。正式 Compose 只信任單一反向代理 hop，且只把應用程式埠綁定至伺服器 loopback；請勿把 `TRUST_PROXY_HOPS` 設為 1 後再直接將 3000 埠暴露至公網。若前方有 CDN 或多層代理，請按實際拓撲調整信任 hop 數，並確保最外層代理會覆寫用戶端 IP 標頭。應用程式內的登入失敗計數會在程序重新啟動後重設，因此仍應保留 Nginx 的每 IP 限制；共享出口 IP 的使用者可能共用 Nginx 節流額度，可依實際流量調整。

### 6. 登入並完成帳戶設定

瀏覽 `https://bot.example.com`，使用 `.env` 的 `ADMIN_PASSWORD` 登入。接著在「放貸系統設定」輸入 Bitfinex API Key 與 Secret，並只啟用放貸必要的 API 權限；使用內建錢包間轉帳才開啟 Wallets 寫入權限，Withdrawal 權限必須關閉。若啟用 Telegram 通知，請設定私人對話的 Chat ID，並妥善保管 Bot Token。

從外部確認 TLS 與服務健康狀態：

```bash
curl --fail https://bot.example.com/api/health
```

### 7. 備份、更新與停止服務

備份資料庫時，先建立只有目前 Linux 使用者可讀的目錄。以下指令將 PostgreSQL dump 寫入專案目錄外的伺服器檔案，不會把資料庫內容印在終端機：

```bash
cd /opt/lending-bot/deploy
sudo install -d -m 700 -o "$USER" -g "$USER" /opt/lending-bot-backups
backup_file="/opt/lending-bot-backups/lending-bot-$(date +%F-%H%M%S).sql"
sudo docker compose --env-file ../.env -f docker-compose.prod.yml exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$backup_file"
chmod 600 "$backup_file"
```

資料庫備份含帳戶與放貸資料，請放在專案目錄外，並另行加密保存異地副本。要還原 dump 會覆蓋目前資料庫；先確認備份可讀、另外保留目前資料庫備份，再停止應用程式、重建資料庫並匯入 dump：

```bash
cd /opt/lending-bot/deploy
backup_file="/opt/lending-bot-backups/lending-bot-YYYY-MM-DD-HHMMSS.sql"
test -s "$backup_file"
sudo docker compose --env-file ../.env -f docker-compose.prod.yml stop lending-bot
sudo docker compose --env-file ../.env -f docker-compose.prod.yml exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" --if-exists "$POSTGRES_DB"'
sudo docker compose --env-file ../.env -f docker-compose.prod.yml exec -T postgres sh -c 'createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
sudo docker compose --env-file ../.env -f docker-compose.prod.yml exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "$backup_file"
sudo docker compose --env-file ../.env -f docker-compose.prod.yml up -d
```

更新前先備份資料，再從專案根目錄拉取原始碼並重新建置：

```bash
cd /opt/lending-bot
git pull --ff-only
cd deploy
sudo docker compose --env-file ../.env -f docker-compose.prod.yml up -d --build
sudo docker compose --env-file ../.env -f docker-compose.prod.yml ps
```

查看日誌或停止服務：

```bash
sudo docker compose --env-file ../.env -f docker-compose.prod.yml logs -f --tail=200
sudo docker compose --env-file ../.env -f docker-compose.prod.yml stop
```

`docker compose down` 會停止並移除容器，但保留資料 volume。`docker compose down -v` 會刪除 PostgreSQL 資料，除非已確認備份並確定要清空資料，否則不要執行。第一次部署後，PostgreSQL 的實際角色密碼也存於資料 volume；不要只改 `.env` 就假設既有資料庫密碼已更新。

### 維護者的 GHCR 與 GitHub Actions 部署

一般使用者依照上面的原始碼建置步驟即可。維護者若要沿用 GitHub Actions 推送 GHCR 映像的流程，請先在 repository 的 **Settings → Environments** 建立 `production` 環境並設定必要 reviewer，再把 `OCI_VM_IP`、`OCI_VM_USER`、`OCI_SSH_PRIVATE_KEY` 與 `OCI_VM_HOST_FINGERPRINT` 設為該環境的 secrets。部署工作會等待環境規則核准；請勿將 SSH 私鑰放在一般程式碼或 workflow 檔案。請從 VM 的可信任主控台取得 SSH 主機指紋：

```bash
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256 | awk '{print $2}'
```

確認該指紋確實來自自己的 VM 後，再將完整 `SHA256:...` 值存為 `OCI_VM_HOST_FINGERPRINT`。VM 上也要預先建立專案目錄、設定權限為 `600` 的私密 `.env` 並安裝 Docker。部署 workflow 只接受 `main` 分支推送、每次都執行測試，且部署前固定第三方 Actions 版本及驗證 SSH 主機指紋。

公開 repository 前，請在 GitHub 為 `main` 設定分支保護：要求 pull request、至少一位 reviewer、要求 `CI / test` 通過、禁止 force push，並限制可直接推送 `main` 的人員。再確認 `production` 環境的 reviewer 規則已生效，且環境 secrets 只給部署工作使用。部署 workflow 將測試、GHCR 發佈和遠端部署拆成不同工作：只有映像發佈工作有 `packages: write`，依賴安裝與測試不持有發佈權限，所有 Checkout 都關閉持久化 Git 憑證；每次部署指定該次 commit 的 SHA image tag，避免遠端拉取不確定的 `latest`。CI 會對前後端執行 `npm audit`，Dependabot 每週檢查 npm 套件與 GitHub Actions 更新；請審查自動更新 pull request，再合併。GHCR package 的公開／私有狀態需另行管理；公開 GitHub repository 不會自動改變容器套件的可見性。`deploy/setup.sh` 會拉取 GHCR 映像，因此若套件設為 private，仍需在伺服器設定有 `read:packages` 權限的讀取憑證；它不會設定 Nginx、TLS 或雲端防火牆。

### Kubernetes 參考部署

`k8s/` 提供應用程式 Deployment、ClusterIP Service 與 ingress-nginx Ingress 範本，不會建立 PostgreSQL、Kubernetes Secret、Ingress Controller 或 TLS 憑證。請先準備可連線的外部 PostgreSQL（需支援經驗證的 TLS）、Kubernetes cluster、ingress-nginx controller 與正式網域。若 GHCR package 是私有套件，另需建立只具 `read:packages` 權限的 image pull secret。範本中的 `k8s/k8s-secret.yaml` 只有無效佔位值，請勿套用或填入真實憑證。

先編輯 `k8s/k8s-configmap.yaml`、`k8s/k8s-ingress.yaml`，將 `lendingbot.local` 改成實際網域，設定 TLS Secret／cert-manager issuer，並依網路拓撲設定 `TRUST_PROXY_HOPS`。Rate limit 與連線限制由 ingress-nginx 按來源 IP 套用；多個 controller replicas 會按副本數放大有效額度，請按實際流量調整。建立在 repository 外的秘密 env 檔，至少填入 `DATABASE_URL`、`ADMIN_PASSWORD`、`JWT_SECRET`，並選擇性填入 Telegram 變數。範本不綁定 namespace；以下命令預設使用 `default`，也可在執行前設定 `NAMESPACE`：

```bash
umask 077
install -m 600 /dev/null /secure/path/lending-bot-k8s.env
${EDITOR:-nano} /secure/path/lending-bot-k8s.env
NAMESPACE="${NAMESPACE:-default}"
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret generic lending-bot-secret --namespace "$NAMESPACE" --from-env-file=/secure/path/lending-bot-k8s.env --dry-run=client -o yaml | kubectl apply -f -
kubectl apply --namespace "$NAMESPACE" -f k8s/k8s-configmap.yaml
kubectl apply --namespace "$NAMESPACE" -f k8s/k8s-deployment.yaml
kubectl apply --namespace "$NAMESPACE" -f k8s/k8s-service.yaml
kubectl apply --namespace "$NAMESPACE" -f k8s/k8s-ingress.yaml
kubectl rollout status deployment/lending-bot-deployment --namespace "$NAMESPACE" --timeout=180s
kubectl logs deployment/lending-bot-deployment --namespace "$NAMESPACE" --tail=100
curl --fail https://bot.example.com/api/health
```

請先確認 Secret、外部資料庫、正式網域、TLS 與 image pull 權限都已設定，再套用 Deployment；不要將 env 檔或產生的 Secret YAML 放入 Git。Bitfinex API Key 與 Secret 請登入後在儀表板輸入。更多參考：[Docker Engine 官方 Ubuntu 安裝文件](https://docs.docker.com/engine/install/ubuntu/)、[Nginx 登入請求速率限制](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html)、[Nginx 同時連線限制](https://nginx.org/en/docs/http/ngx_http_limit_conn_module.html)、[Nginx WebSocket 反向代理](https://nginx.org/en/docs/http/websocket.html)、[Certbot Nginx 安裝指引](https://certbot.eff.org/instructions)、[ingress-nginx rate limit 與 connection limit](https://kubernetes.github.io/ingress-nginx/user-guide/nginx-configuration/annotations/)。

## 資料與維護

- 首次建立新的 PostgreSQL volume 時，Compose 會執行 `deploy/init-db/` 中的初始化 SQL。既有 volume 不會重新執行初始化檔。
- PostgreSQL 資料儲存在 `postgres_data` 或 `postgres_dev_data` volume；升級或重建容器前請先備份資料庫及 `.env`。
- 啟動後會另外收集 USD Funding 分鐘行情、影子決策、真實掛單／取消事件與私有 Funding Trades 配對結果。研究資料預設保留 180 天；公開行情收集不依賴放貸引擎是否啟動。影子模型不會送出或取消訂單，現行放貸策略仍單獨控制真實下單。
- 私有成交僅保存成交 ID、`OFFER_ID`、執行時間、金額、利率與期限；不保存 API 憑證或 Bitfinex 原始私有回應。未能依 `OFFER_ID` 找到本機掛單紀錄的成交會保留為未配對，不用利率或時間推測關聯。
- 預測期間在首 30 天後，以至少 50 筆 `OFFER_ID` 精確配對成交的成交等待時間第 75 百分位鎖定；樣本不足時使用 24 小時。模型比較包含持續性、近一小時均值、Ridge、Huber、HistGradientBoosting 與 P10/P50/P90 Quantile regression。舊版來源不明的權重不會載入。
- 首次模型評估以第 1–30 天訓練、第 31–45 天選定有限參數、第 46–60 天做鎖定測試；若行情完整度低於 90%、配對成交少於 50 筆，或成熟標籤不足，訓練程式會拒絕發布並要求延長收集。跨越時間切分邊界的標籤會排除。模型評分以 MAE 為主，分位數另記錄 pinball loss 與區間涵蓋率。
- 離線訓練需要可連線至同一個 PostgreSQL 的 Python 環境：

  ```bash
  python -m venv .venv-ml
  .venv-ml/bin/pip install -r scripts/requirements-ml.txt
  .venv-ml/bin/python scripts/train_research_models.py --env-file .env
  ```

  Windows PowerShell 可將 `.venv-ml/bin/` 換成 `.venv-ml/Scripts/`。程式從 `.env` 讀取 PostgreSQL 連線設定，輸出路徑只保存版本化模型；訓練結果與啟用模型會寫入 PostgreSQL，Node 評分器每分鐘讀取。為控制 Quantile regression 的離線運算量，每個時間區間最多使用 5,000 筆等距樣本，所有候選共用同一批樣本。不會讀取 Bitfinex 私鑰、不呼叫交易 API，也不會把環境變數列印到終端機。訓練只會在符合樣本門檻時更新啟用模型。
- 正式資料庫的備份與還原步驟見上方「備份、更新與停止服務」。


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
scripts/train_research_models.py  離線時間序列訓練與鎖定測試
deploy/docker-compose.yml       開發用 App + PostgreSQL
deploy/docker-compose.prod.yml  正式環境原始碼 build／GHCR image + PostgreSQL
deploy/init-db/         新資料庫初始化 SQL
supabase/               舊版 Supabase 相容／遷移檔案；不是目前主要部署依賴
```

## 授權

本專案以 ISC License 授權，詳見 [LICENSE](LICENSE)。

## 風險聲明

本工具會對 Bitfinex Funding 帳戶執行操作。加密資產放貸可能造成資金損失或無法即時取回資金；使用前請自行審查策略、限制 API 權限並評估風險。本專案不構成投資或財務建議。
