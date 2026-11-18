FROM oven/bun:1.4.4-slim
WORKDIR /app
COPY server.ts .
ENV DB_URL=postgres://bench:bench@127.0.0.1:5432/bench WORKERS=2
EXPOSE 8080
CMD ["bun", "server.ts"]
