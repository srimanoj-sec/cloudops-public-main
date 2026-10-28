# CloudOps — Host-mode dev launcher (Windows).
#
# Runs the API on the host so it reuses your interactive `az login` (the
# containerized API cannot, because the Windows az token cache is DPAPI-encrypted
# and not portable to Linux). Postgres, Redis, and Web stay in Docker.
#
# Usage:  pwsh ./scripts/dev-host.ps1
# Then open the UI at http://localhost:5173 and click "Sync Azure".

$ErrorActionPreference = "Stop"

# Make sure you are logged in to Azure.
az account show 1>$null 2>$null
if ($LASTEXITCODE -ne 0) { Write-Host "Run 'az login' first." -ForegroundColor Yellow; exit 1 }

# Infra + UI in Docker; API on the host (frees port 3000 for the host API).
docker compose up -d postgres redis web
docker compose stop api 2>$null

$env:DATABASE_URL   = "postgresql://cloudops:cloudops@localhost:5432/cloudops?schema=public"
$env:REDIS_URL      = "redis://localhost:6379"
$env:JWT_ACCESS_SECRET  = "dev-access"
$env:JWT_REFRESH_SECRET = "dev-refresh"
$env:NODE_ENV       = "development"
$env:API_PORT       = "3000"

# First run only: create schema + seed admin (safe to re-run).
pnpm --filter '@cloudops/api' exec prisma db push --skip-generate
pnpm --filter '@cloudops/api' prisma:seed

Write-Host "Starting API on http://localhost:3000 (Ctrl+C to stop)..." -ForegroundColor Cyan
pnpm --filter '@cloudops/api' start
