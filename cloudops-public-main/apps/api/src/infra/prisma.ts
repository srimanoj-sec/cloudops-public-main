import { PrismaClient } from '@prisma/client';
import { config } from '../env.js';

export const prisma = new PrismaClient({
  log: config.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

export type Prisma = typeof prisma;
