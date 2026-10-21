FROM node:22-alpine AS client-build

WORKDIR /build

COPY client/package.json client/package-lock.json ./client/
RUN cd client && npm ci
COPY client/ ./client/
RUN cd client && npm run build

FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node server/ server/
COPY --chown=node:node --from=client-build /build/client/dist ./client/dist
COPY .env.example .env.example

USER node

# 暴露埠號
EXPOSE 3000

# 健康檢查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

# 啟動
CMD ["node", "server/index.js"]
