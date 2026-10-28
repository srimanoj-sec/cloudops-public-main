import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Host-mode / local development: load `apps/api/.env` if it exists. Variables
 * already set in the environment always win (Node's loadEnvFile never
 * overrides), so Docker Compose and CI are unaffected — and the image never
 * contains this file (.dockerignore). It is deliberately NOT the repo-root
 * `.env`: that one is written for the containers (hosts like `postgres`,
 * `/root/.azure`) and would point a host-mode API at the wrong places.
 */
const envFile = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');
if (existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envFile);
}
