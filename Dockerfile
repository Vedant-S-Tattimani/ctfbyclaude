# fs0cie1y (CipherArena): the Express API serving the static frontend, on Node 22.
# Used by Render in production and by docker-compose.yml for local development.
# Secrets (backend/.env, serviceAccountKey.json) are never copied in: see .dockerignore.
FROM node:22-bookworm-slim

WORKDIR /app

# Install dependencies first so this layer is cached until package*.json change.
COPY backend/package*.json ./backend/
RUN cd backend && npm ci --omit=dev && npm cache clean --force

COPY backend/ ./backend/
COPY frontend/ ./frontend/

ENV NODE_ENV=production DATA_DIR=/data PORT=3000 FRONTEND_DIR=/app/frontend
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 3000
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "backend/server/index.js"]
