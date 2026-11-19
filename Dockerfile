# syntax=docker/dockerfile:1
# Serwer vibe-kanban (UI + API). Sesje Claude działają na hoście — patrz README.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY src ./src
COPY ui ./ui
RUN npm run build

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 # repozytoria są montowane z hosta — nie blokuj ich z powodu właściciela
 && git config --system safe.directory '*'
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 4777
ENV VK_BIND=0.0.0.0 VK_PORT=4777
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:4777/api/health',{headers:{host:'localhost'}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--no-warnings=ExperimentalWarning", "dist/cli.js", "serve"]
