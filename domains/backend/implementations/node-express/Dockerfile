# Node.js 26 LTS runs the TypeScript source directly (built-in type stripping).
FROM node:26.13.1-trixie-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.ts .
ENV NODE_ENV=production DB_URL=postgres://bench:bench@127.0.0.1:5432/bench WORKERS=2
EXPOSE 8080
CMD ["node", "server.ts"]
