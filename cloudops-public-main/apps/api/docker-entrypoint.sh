#!/bin/sh
# CloudOps API container entrypoint.
#  1. Bring the schema up to date (versioned migrations; adopts legacy
#     `db push` databases automatically — see prisma/migrate.ts).
#  2. Idempotent seed (roles, first admin, provider record).
#  3. `exec` the API so it becomes the signal target: `docker stop` sends
#     SIGTERM straight to Node, which drains workers and shuts down cleanly.
set -eu
cd /app/apps/api

node --import tsx prisma/migrate.ts
node --import tsx prisma/seed.ts

exec node --import tsx src/main.ts
