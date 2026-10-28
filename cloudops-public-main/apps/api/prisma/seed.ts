import '../src/infra/load-env.js';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

/**
 * Idempotent seed: roles, the seed admin user, a default board, and the
 * standard environments. Safe to re-run.
 */
const prisma = new PrismaClient();

const ROLES = [
  { key: 'admin', description: 'Full administrative access' },
  { key: 'operator', description: 'Can run syncs and manage work items' },
  { key: 'viewer', description: 'Read-only access' },
];

const ENVIRONMENTS: { name: string; type: 'Production' | 'Stage' | 'QA' | 'Dev' | 'Sandbox' }[] = [
  { name: 'Production', type: 'Production' },
  { name: 'Stage', type: 'Stage' },
  { name: 'QA', type: 'QA' },
  { name: 'Dev', type: 'Dev' },
  { name: 'Sandbox', type: 'Sandbox' },
];

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@cloudops.local';
  const password = process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe123!';

  for (const role of ROLES) {
    await prisma.role.upsert({ where: { key: role.key }, update: {}, create: role });
  }

  for (const env of ENVIRONMENTS) {
    await prisma.environment.upsert({ where: { name: env.name }, update: {}, create: env });
  }

  const adminRole = await prisma.role.findUniqueOrThrow({ where: { key: 'admin' } });
  const existing = await prisma.user.findUnique({ where: { email } });
  if (!existing) {
    const passwordHash = await bcrypt.hash(password, 10);
    await prisma.user.create({
      data: {
        email,
        name: 'Administrator',
        passwordHash,
        mustChangePassword: true,
        roles: { create: [{ roleId: adminRole.id }] },
      },
    });
    console.log(`✓ Seeded admin user: ${email}`);
  } else {
    console.log(`• Admin user already exists: ${email}`);
  }

  // Register the Azure provider record (metadata only; no secrets).
  await prisma.provider.upsert({
    where: { key: 'azure' },
    update: {},
    create: {
      key: 'azure',
      displayName: 'Microsoft Azure',
      capabilities: ['inventory'],
      status: 'registered',
    },
  });
  await prisma.provider.upsert({
    where: { key: 'gcp' },
    update: {
      capabilities: ['inventory', 'security', 'metrics', 'rbac', 'health', 'recommendations', 'execution'],
    },
    create: {
      key: 'gcp',
      displayName: 'Google Cloud',
      capabilities: ['inventory', 'security', 'metrics', 'rbac', 'health', 'recommendations', 'execution'],
      status: 'registered',
    },
  });

  // A default board for work management.
  const boardCount = await prisma.board.count();
  if (boardCount === 0) {
    await prisma.board.create({
      data: {
        name: 'Operations',
        columns: {
          create: [
            { name: 'To Do', order: 0 },
            { name: 'In Progress', order: 1 },
            { name: 'Blocked', order: 2 },
            { name: 'Done', order: 3 },
          ],
        },
      },
    });
  }

  console.log('✓ Seed complete');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
