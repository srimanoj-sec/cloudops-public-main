/**
 * Bring the database schema up to date — safe to run on every boot.
 *
 *  - Fresh database:            apply every migration (`prisma migrate deploy`).
 *  - Legacy `db push` database: (tables exist, no `_prisma_migrations`) — the
 *    pre-migrations installs. Sync it exactly the way every previous boot did
 *    (`prisma db push`, additive-only: it refuses data loss), then record every
 *    migration as already applied. From then on it is a normal migrated DB.
 *  - Migrated database:         apply any pending migrations.
 *
 * Afterwards the live schema is diffed against schema.prisma and any drift is
 * reported (never auto-fixed). Invoked by the api container on start and by
 * `pnpm --filter @cloudops/api db:migrate` in host mode.
 */
import '../src/infra/load-env.js';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const here = dirname(fileURLToPath(import.meta.url));
const apiDir = join(here, '..');
const schema = join(here, 'schema.prisma');
const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');

/** Run the Prisma CLI without a shell. Returns the exit code (throws only when `check` is set). */
function prisma(args: string[], check = true): number {
  try {
    execFileSync(process.execPath, [prismaCli, ...args], { cwd: apiDir, stdio: 'inherit' });
    return 0;
  } catch (err) {
    const status = (err as { status?: number }).status ?? 1;
    if (check) throw new Error(`prisma ${args.join(' ')} exited with ${status}`);
    return status;
  }
}

async function main(): Promise<void> {
  const db = new PrismaClient();
  let legacy = false;
  try {
    const [row] = await db.$queryRaw<{ migrations: string | null; users: string | null }[]>`
      SELECT to_regclass('public._prisma_migrations')::text AS migrations,
             to_regclass('public."User"')::text             AS users`;
    legacy = !row?.migrations && Boolean(row?.users);
  } finally {
    await db.$disconnect();
  }

  if (legacy) {
    console.log('• Existing database was managed by `prisma db push` — adopting versioned migrations.');
    prisma(['db', 'push', '--skip-generate', '--schema', schema]);
    const migrations = readdirSync(join(here, 'migrations'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    for (const name of migrations) prisma(['migrate', 'resolve', '--applied', name, '--schema', schema]);
    console.log(`✓ Baselined ${migrations.length} migration(s); no data was modified.`);
  }

  prisma(['migrate', 'deploy', '--schema', schema]);

  // Drift report: exit code 2 = the live schema differs from schema.prisma.
  const drift = prisma(
    ['migrate', 'diff', '--from-url', process.env.DATABASE_URL ?? '', '--to-schema-datamodel', schema, '--exit-code'],
    false,
  );
  if (drift === 2) {
    console.warn('! The database schema differs from prisma/schema.prisma (manual changes?). See the diff above.');
  } else {
    console.log('✓ Database schema is up to date.');
  }
}

main().catch((err) => {
  console.error('✗ Database migration failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
