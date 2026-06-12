#!/bin/bash

# ==============================================================================
# Bitfinex Lending Bot - Oracle Cloud 一鍵部署腳本 (setup.sh)
# ==============================================================================
# 此腳本專為 Oracle Cloud Infrastructure (OCI) 的 VM 設計。
# 支援作業系統：Ubuntu 20.04/22.04+ 及 Oracle Linux 8+。
# 功能：自動安裝 Docker、Docker Compose、開放作業系統防火牆 Port 3000、生成並啟動服務。
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
    apt-get install -y ca-certificates curl gnupg lsb-release
    
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
    
    dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    systemctl enable --now docker
  else
    echo -e "${RED}不支援的作業系統！請手動安裝 Docker 與 Docker Compose 後再執行此腳本。${NC}"
    exit 1
  fi
  
  echo -e "${GREEN}Docker 安裝成功！${NC}"
}

install_docker

# 3. 處理 Oracle Cloud 防火牆限制 (開通 Port 3000)
configure_firewall() {
  echo -e "${YELLOW}正在設定伺服器防火牆，開放 Port 80 與 443...${NC}"
  
  # 方法 A: Ubuntu 預設的 iptables (OCI Ubuntu 映像檔專屬痛點解決方案)
  if [ "$OS_TYPE" = "ubuntu" ] || [ "$OS_TYPE" = "debian" ]; then
    if command -v iptables &> /dev/null; then
      # 插入規則至 INPUT 第 6 行 (通常在 REJECT 之前)
      # 開放 80 (HTTP) 與 443 (HTTPS)
      iptables -I INPUT 6 -p tcp --dport 80 -j ACCEPT || iptables -I INPUT -p tcp --dport 80 -j ACCEPT
      iptables -I INPUT 6 -p tcp --dport 443 -j ACCEPT || iptables -I INPUT -p tcp --dport 443 -j ACCEPT
      
      # 存檔以確保重開機後依然有效
      if command -v netfilter-persistent &> /dev/null; then
        netfilter-persistent save
      elif apt-get install -y netfilter-persistent iptables-persistent < /dev/null; then
        netfilter-persistent save
      fi
      echo -e "${GREEN}已成功通過 iptables 開放 Port 80 與 443。${NC}"
    fi
    
    # 若有啟用 ufw，也一併放行
    if command -v ufw &> /dev/null && ufw status | grep -q "active"; then
      ufw allow 80/tcp
      ufw allow 443/tcp
      echo -e "${GREEN}已通過 ufw 開放 Port 80 與 443。${NC}"
    fi

  # 方法 B: Oracle Linux / Centos 的 firewalld
  elif [ "$OS_TYPE" = "ol" ] || [ "$OS_TYPE" = "rhel" ] || [ "$OS_TYPE" = "centos" ]; then
    if systemctl is-active --quiet firewalld; then
      firewall-cmd --zone=public --add-port=80/tcp --permanent
      firewall-cmd --zone=public --add-port=443/tcp --permanent
      firewall-cmd --reload
      echo -e "${GREEN}已成功通過 firewalld 開放 Port 80 與 443。${NC}"
    else
      echo -e "${YELLOW}firewalld 未啟用，跳過此防火牆設定。${NC}"
    fi
  fi
}

configure_firewall

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
      
      # 自動隨機生成安全 JWT Secret
      RANDOM_JWT=$(openssl rand -hex 24 2>/dev/null || echo "lendingbot_secret_$(date +%s)")
      # 替換範本中的預設值
      sed -i "s/your_jwt_secret_change_this/$RANDOM_JWT/g" "$ENV_FILE" 2>/dev/null || \
      sed -i "" "s/your_jwt_secret_change_this/$RANDOM_JWT/g" "$ENV_FILE"
      
      echo -e "${GREEN}已成功建立 .env 檔案並為您自動生成了隨機的 JWT_SECRET！${NC}"
    else
      echo -e "${RED}錯誤: 找不到 .env.example 範本檔，無法自動初始化！${NC}"
      exit 1
    fi
  fi

  echo -e "\n${YELLOW}請注意：您必須填入 Bitfinex API 金鑰、Supabase 資訊，以及用於 SSL 證書申請的域名和 Email 才能運作！${NC}"
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
    echo -e "${YELLOW}跳過編輯，請記得稍後手動編輯位於專案根目錄的 .env 檔案！${NC}"
  fi
}

setup_env

# 5. 構建並啟動 Docker 容器
start_container() {
  echo -e "${YELLOW}正在透過 Docker Compose 構建並啟動 Lending Bot, Nginx 與 SSL 精靈...${NC}"
  
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
  cd "$SCRIPT_DIR"
  
  docker compose -f docker-compose.prod.yml up -d --build
  
  echo -e "${GREEN}======================================================================${NC}"
  echo -e "${GREEN}🎉 部署完成！機器人與 Nginx 安全反向代理已成功運行。${NC}"
  echo -e "${GREEN}👉 安全存取網址：https://您的網域 (需已完成 DNS 解析)${NC}"
  echo -e "${GREEN}👉 臨時 HTTP 網址：http://您的主機公網IP (SSL 證書申請中/或未配置網域時)${NC}"
  echo -e "${GREEN}🔧 您可以執行 'docker compose -f docker-compose.prod.yml logs -f' 來查看實時日誌。${NC}"
  echo -e "${GREEN}======================================================================${NC}"
}

start_container
