/**
 * Standalone worker entrypoint (optional). The default deployment runs every
 * worker in-process with the API; run this to move background processing into
 * its own container/process. BullMQ distributes jobs, so running both is safe.
 */
import { logger } from '../infra/logger.js';
import { prisma } from '../infra/prisma.js';
import { compose } from '../composition.js';

async function bootstrap(): Promise<void> {
  const composition = await compose();
  await composition.kernel.lifecycle.init();
  await composition.kernel.lifecycle.start(); // sync, cost, tags, evaluation, remediation, maintenance workers
  logger.info('standalone workers started');

  const shutdown = async (signal: string) => {
    logger.info(`received ${signal}, draining workers`);
    await composition.kernel.lifecycle.stop();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  logger.error('failed to start worker', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
