FROM node:20-alpine

WORKDIR /app

# 安裝後端依賴
COPY package.json package-lock.json ./
RUN npm ci --production

# 安裝前端依賴並建置
COPY client/package.json client/
RUN cd client && npm install
COPY client/ client/
RUN cd client && npm run build

# 複製後端程式碼
COPY server/ server/
COPY .env.example .env.example

# 暴露埠號
EXPOSE 3000

# 健康檢查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

# 啟動
CMD ["node", "server/index.js"]
