# Production image for the API and the worker (same image; APP picks which one runs).
#   docker build -t match-cut .
#   docker run -e APP=api ...     or     docker run -e APP=worker ...
# Workspace packages are TypeScript source run with tsx, so there is no separate build step.
FROM node:22-bookworm-slim

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NODE_ENV=production
RUN corepack enable
WORKDIR /app

# Dependencies first, for layer caching. Only what the API and worker need.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/providers/package.json packages/providers/
COPY packages/infra/package.json packages/infra/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --prod \
      --filter "@match-cut/api..." --filter "@match-cut/worker..."

# Source, config (capability manifest, pricing), migrations and mock fixtures.
COPY tsconfig.base.json ./
COPY config ./config
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker

USER node
ENV APP=api
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD [ "$APP" != "api" ] || node -e "fetch('http://127.0.0.1:'+(process.env.PORT||process.env.API_PORT||4000)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "cd apps/$APP && exec node --import tsx src/index.ts"]
