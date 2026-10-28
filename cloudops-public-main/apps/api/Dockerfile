# CloudOps API — Express app + in-process background workers.
# Includes the Azure CLI (and the resource-graph extension) for provider sync.
FROM node:22-bookworm-slim

# Azure CLI (Debian) + curl for the installer.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && curl -sL https://aka.ms/InstallAzureCLIDeb | bash \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

# resource-graph extension (fast estate discovery), installed OUTSIDE the
# per-org CLI profiles via AZURE_EXTENSION_DIR so no profile volume can shadow
# it. Cost Management (FinOps) uses `az rest` — no extension needed.
ENV AZURE_EXTENSION_DIR=/opt/az/cliextensions \
    AZURE_EXTENSION_USE_DYNAMIC_INSTALL=yes_without_prompt \
    AZURE_CORE_COLLECT_TELEMETRY=no
RUN mkdir -p "$AZURE_EXTENSION_DIR" \
  && az extension add --name resource-graph --only-show-errors

RUN corepack enable

WORKDIR /app

# Manifests first so the dependency layer is cached across source changes.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/kernel/package.json packages/kernel/
COPY packages/core/package.json packages/core/
COPY packages/credentials/package.json packages/credentials/
COPY packages/provider-sdk/package.json packages/provider-sdk/
COPY packages/provider-azure/package.json packages/provider-azure/
COPY packages/provider-gcp/package.json packages/provider-gcp/
COPY apps/api/package.json apps/api/
# Reproducible: install exactly what the lockfile pins (fails if it's stale).
RUN pnpm install --frozen-lockfile --filter "@cloudops/api..."

COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm --filter @cloudops/api prisma:generate \
  && chmod +x apps/api/docker-entrypoint.sh

ENV NODE_ENV=production \
    PRISMA_HIDE_UPDATE_MESSAGE=1
EXPOSE 3000

# Liveness: the process is up (readiness — DB + Redis — is /health/ready).
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD node -e "fetch('http://localhost:3000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/apps/api/docker-entrypoint.sh"]
