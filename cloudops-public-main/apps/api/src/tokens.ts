import { createToken, type EventBus, type Logger } from '@cloudops/kernel';
import type { CredentialChain } from '@cloudops/credentials';
import type { Prisma } from './infra/prisma.js';

/** DI tokens for cross-cutting singletons. Feature services resolve these. */
export const TOKENS = {
  Prisma: createToken<Prisma>('Prisma'),
  Logger: createToken<Logger>('Logger'),
  EventBus: createToken<EventBus>('EventBus'),
  CredentialChain: createToken<CredentialChain>('CredentialChain'),
} as const;
