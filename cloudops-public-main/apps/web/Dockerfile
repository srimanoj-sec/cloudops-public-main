# CloudOps Web — build the Vite SPA, serve it from unprivileged nginx.

# ── build ───────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter "@cloudops/web..."

COPY packages/core ./packages/core
COPY apps/web ./apps/web

# The API URL is baked into the bundle (the browser calls it directly).
ARG VITE_API_BASE_URL=http://localhost:3000
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN pnpm --filter @cloudops/web exec vite build

# ── serve ───────────────────────────────────────────────────────────
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf.template /etc/nginx/templates/default.conf.template
# Only substitute our variable (nginx's own $uri etc. must survive envsubst).
ENV NGINX_ENVSUBST_FILTER=^API_ORIGIN$ \
    API_ORIGIN=http://localhost:3000
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
