#!/bin/bash

# ==============================================================================
# Bitfinex Lending Bot - Oracle Cloud 一鍵部署腳本 (setup.sh)
# ==============================================================================
# 此腳本專為 Oracle Cloud Infrastructure (OCI) 的 VM 設計。
# 支援作業系統：Ubuntu 20.04/22.04+ 及 Oracle Linux 8+。
# 功能：自動安裝 Docker、產生初始密鑰並啟動應用程式與 PostgreSQL。
# ==============================================================================

set -e

# 字體顏色定義
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}======================================================================${NC}"
echo -e "${GREEN}   Bitfinex Lending Bot - Oracle Cloud 自動化部署工具${NC}"
echo -e "${GREEN}======================================================================${NC}"

# 1. 檢查是否以 root 權限執行
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}錯誤: 請使用 sudo 權限執行此腳本！${NC}"
  echo "範例: sudo bash setup.sh"
  exit 1
fi

# 偵測作業系統類型
OS_TYPE="unknown"
if [ -f /etc/os-release ]; then
  . /etc/os-release
  OS_TYPE=$ID
fi

echo -e "偵測到作業系統: ${YELLOW}$OS_TYPE${NC}"

# 2. 自動安裝 Docker & Docker Compose
install_docker() {
  if command -v docker &> /dev/null && command -v docker compose &> /dev/null; then
    echo -e "${GREEN}Docker 與 Docker Compose 已安裝，跳過此步驟。${NC}"
    return 0
  fi

  echo -e "${YELLOW}正在安裝 Docker 與 Docker Compose...${NC}"
  
  if [ "$OS_TYPE" = "ubuntu" ] || [ "$OS_TYPE" = "debian" ]; then
    apt-get update -y
    apt-get install -y ca-certificates curl gnupg lsb-release openssl
    
    mkdir -p /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg --yes
    
    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
      $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
      
    apt-get update -y
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  elif [ "$OS_TYPE" = "ol" ] || [ "$OS_TYPE" = "rhel" ] || [ "$OS_TYPE" = "centos" ]; then
    # Oracle Linux 或 RHEL 體系
    dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo || \
    yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
    
    dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin openssl
    systemctl enable --now docker
  else
    echo -e "${RED}不支援的作業系統！請手動安裝 Docker 與 Docker Compose 後再執行此腳本。${NC}"
    exit 1
  fi
  
  echo -e "${GREEN}Docker 安裝成功！${NC}"
}

install_docker

# 3. 防火牆與 TLS 由主機既有的反向代理管理；本腳本不開放公網連接埠。
echo -e "${YELLOW}本腳本不修改防火牆。正式對外服務請設定 TLS 反向代理，並限制應用程式連接埠的來源。${NC}"

# 4. 初始化環境變數設定 (.env)
setup_env() {
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
  ROOT_DIR="$(dirname "$SCRIPT_DIR")"
  ENV_FILE="$ROOT_DIR/.env"
  ENV_EXAMPLE="$ROOT_DIR/.env.example"

  if [ -f "$ENV_FILE" ]; then
    echo -e "${GREEN}.env 設定檔已存在。${NC}"
  else
    echo -e "${YELLOW}未偵測到 .env，正在複製範本 .env.example 並自動初始化...${NC}"
    if [ -f "$ENV_EXAMPLE" ]; then
      cp "$ENV_EXAMPLE" "$ENV_FILE"
      
      echo -e "${GREEN}已建立 .env 範本。${NC}"
    else
      echo -e "${RED}錯誤: 找不到 .env.example 範本檔，無法自動初始化！${NC}"
      exit 1
    fi
  fi

  if ! command -v openssl &> /dev/null; then
    echo -e "${RED}錯誤: 找不到 openssl，無法安全產生服務密鑰。${NC}"
    exit 1
  fi

  write_secret_if_missing() {
    local key="$1"
    local min_length="$2"
    local current
    current="$(sed -n "s/^${key}=//p" "$ENV_FILE" | head -n 1)"
    case "${current,,}" in
      *your_*|*change_me*|*default*|*example*|*lending_bot_db_password*) current="" ;;
      *) if [ "${#current}" -ge "$min_length" ]; then return; fi ;;
    esac

    local value
    value="$(openssl rand -hex 32)"
    if grep -q "^${key}=" "$ENV_FILE"; then
      sed -i "s/^${key}=.*/${key}=${value}/" "$ENV_FILE"
    else
      printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
    fi
  }

  write_secret_if_missing POSTGRES_PASSWORD 32
  write_secret_if_missing ADMIN_PASSWORD 12
  write_secret_if_missing JWT_SECRET 32
  chmod 600 "$ENV_FILE"

  echo -e "\n${YELLOW}請確認 .env 內的管理員密碼，並在儀表板設定 Bitfinex API 金鑰。資料庫與 JWT 密鑰已在空值時隨機產生。${NC}"
  read -p "您是否要現在編輯 .env 檔案？ (y/n): " EDIT_NOW
  if [ "$EDIT_NOW" = "y" ] || [ "$EDIT_NOW" = "Y" ]; then
    if command -v nano &> /dev/null; then
      nano "$ENV_FILE"
    elif command -v vi &> /dev/null; then
      vi "$ENV_FILE"
    else
      echo -e "${RED}未找到編輯器 (nano/vi)，請稍後手動使用命令 'nano .env' 編輯。${NC}"
    fi
  else
    echo -e "${YELLOW}已跳過編輯；請確認根目錄 .env 中的 ADMIN_PASSWORD，之後使用它登入儀表板。${NC}"
  fi
}

setup_env

# 5. 拉取並啟動 Docker 容器
start_container() {
  echo -e "${YELLOW}正在透過 Docker Compose 啟動 Lending Bot 與 PostgreSQL...${NC}"
  
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
  cd "$SCRIPT_DIR"

  docker compose --env-file ../.env -f docker-compose.prod.yml pull
  docker compose --env-file ../.env -f docker-compose.prod.yml run --rm --no-deps lending-bot node -e 'require("./server/config")'
  docker compose --env-file ../.env -f docker-compose.prod.yml up -d postgres

  attempts=0
  until docker compose --env-file ../.env -f docker-compose.prod.yml exec -T postgres sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > /dev/null; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 30 ]; then
      echo -e "${RED}錯誤: PostgreSQL 未能在 60 秒內就緒。${NC}"
      exit 1
    fi
    sleep 2
  done

  docker compose --env-file ../.env -f docker-compose.prod.yml exec -T postgres sh -c 'exec psql -X -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1' <<'SQL'
\getenv db_user POSTGRES_USER
\getenv db_password POSTGRES_PASSWORD
ALTER ROLE :"db_user" WITH PASSWORD :'db_password';
\unset db_password
\unset db_user
SQL
  docker compose --env-file ../.env -f docker-compose.prod.yml up -d lending-bot
  
  echo -e "${GREEN}======================================================================${NC}"
  echo -e "${GREEN}🎉 部署完成！Lending Bot 與 PostgreSQL 已啟動。${NC}"
  echo -e "${GREEN}👉 應用程式監聽 Port 3000；請透過已設定 TLS 的反向代理對外提供服務。${NC}"
  echo -e "${GREEN}🔧 您可以執行 'docker compose --env-file ../.env -f docker-compose.prod.yml logs -f' 來查看即時日誌。${NC}"
  echo -e "${GREEN}======================================================================${NC}"
}

start_container
