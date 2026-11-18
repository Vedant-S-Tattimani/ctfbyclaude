FROM node:22-bookworm-slim
WORKDIR /app
COPY backend/package*.json ./backend/
RUN cd backend && npm ci --omit=dev
COPY backend/ ./backend/
COPY frontend/ ./frontend/
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 FRONTEND_DIR=/app/frontend
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 3000
USER node
CMD ["node", "backend/server/index.js"]

