import { config, configSecurityIssues } from './env.js';
import { logger } from './infra/logger.js';
import { prisma } from './infra/prisma.js';
import { compose } from './composition.js';
import { createApp } from './app.js';

/** Hard deadline for graceful shutdown before the process exits anyway. */
const SHUTDOWN_TIMEOUT_MS = 25_000;

async function bootstrap(): Promise<void> {
  // In production insecure secrets are fatal (see env.ts); here we surface the rest.
  const { fatal, warnings } = configSecurityIssues(config);
  for (const issue of [...fatal, ...warnings]) {
    logger.warn(`insecure configuration: ${issue}`, { hint: 'fine for local development; fix before exposing the API' });
  }

  const composition = await compose();

  // Kernel lifecycle: init -> start (starts in-process workers).
  await composition.kernel.lifecycle.init();
  await composition.kernel.lifecycle.start();

  const app = createApp(composition);
  const server = app.listen(config.API_PORT, () => {
    logger.info(`CloudOps API listening on http://localhost:${config.API_PORT}`);
    logger.info(`API docs at http://localhost:${config.API_PORT}/api/docs`);
  });
  // Longer than typical proxy idle timeouts, so the proxy closes idle sockets first.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${signal}, shutting down`);
    const force = setTimeout(() => {
      logger.error('graceful shutdown timed out; exiting');
      process.exit(exitCode || 1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();
    try {
      // Stop accepting connections; in-flight requests finish.
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // Workers drain their active jobs, then queues/Redis close.
      await composition.kernel.lifecycle.stop();
      await prisma.$disconnect();
    } catch (err) {
      logger.error('error during shutdown', { error: err instanceof Error ? err.message : String(err) });
      exitCode = exitCode || 1;
    }
    process.exit(exitCode);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Last-resort safety nets: log with context, and restart cleanly on a crash
  // rather than limping on in an unknown state (the container restarts us).
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled promise rejection', {
      error: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception — shutting down', { error: err.message, stack: err.stack });
    void shutdown('uncaughtException', 1);
  });
}

bootstrap().catch((err) => {
  logger.error('failed to start API', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
