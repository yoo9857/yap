# CraftYap — single-port production image (static client + WS + SQLite).
# Mirrors the C:\poke deploy model: container binds 127.0.0.1 behind host nginx.

# ---- build stage: pnpm workspace → client dist + bundled server dist ----
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
# install deps first (better cache); lockfile is authoritative
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/client/package.json ./apps/client/
COPY apps/server/package.json ./apps/server/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# ---- runtime stage: only the server's external deps (shared is bundled) ----
# tsup inlines @robo/shared into dist/index.js (noExternal), so the sole
# runtime deps are these four. node:22-slim is glibc → better-sqlite3 pulls a
# prebuilt binary, no compiler in the image.
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    SERVE_STATIC=1 \
    PORT=8081 \
    HOST=0.0.0.0 \
    DB_PATH=../data/records.db
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
# versions pinned to the workspace lockfile — keep in sync on dependency bumps
RUN mkdir -p apps/server \
    && cd apps/server \
    && npm init -y >/dev/null 2>&1 \
    && npm pkg set type=module \
    && npm install --omit=dev --no-audit --no-fund \
        better-sqlite3@12.11.1 pino@9.14.0 ws@8.21.1 zod@3.25.76
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/client/dist ./apps/client/dist
# SQLite lives here; bind-mount a host dir over it in compose for persistence
RUN mkdir -p apps/server/data
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=15s \
    CMD curl -fsS http://localhost:8081/healthz || exit 1
CMD ["node", "apps/server/dist/index.js"]
