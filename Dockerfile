# The world's home on a server (Railway). No dependencies: Node runs the TypeScript directly.
FROM node:24-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV NODE_ENV=production \
    DATA_DIR=/data \
    WAIT_FOR_WORLD=1
# Saves, backups and the lock live on the mounted volume at /data.
CMD ["node", "src/main.ts"]
