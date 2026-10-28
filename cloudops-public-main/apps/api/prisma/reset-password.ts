/**
 * Break-glass account recovery for whoever operates the server (shell access =
 * already trusted). Use when the only admin is locked out.
 *
 *   pnpm --filter @cloudops/api user:reset-password <email> [--admin] [--activate]
 *   docker compose exec -w /app/apps/api api node --import tsx prisma/reset-password.ts <email> --admin
 *
 * The new password comes from CLOUDOPS_NEW_PASSWORD, or a strong random one is
 * generated and printed once. The user is signed out everywhere, and the action
 * is recorded in the audit log (actor: "cli").
 */
import '../src/infra/load-env.js';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const email = args.find((a) => !a.startsWith('--'))?.trim().toLowerCase();
  if (!email) {
    console.error('usage: reset-password <email> [--admin] [--activate]');
    process.exit(2);
  }
  const makeAdmin = args.includes('--admin');
  const activate = args.includes('--activate') || makeAdmin;

  const provided = process.env.CLOUDOPS_NEW_PASSWORD;
  if (provided !== undefined && provided.length < 10) {
    console.error('CLOUDOPS_NEW_PASSWORD must be at least 10 characters.');
    process.exit(2);
  }
  const password = provided ?? randomBytes(15).toString('base64url');

  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
    if (!user) {
      console.error(`No user with email ${email}.`);
      process.exit(1);
    }
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash: await bcrypt.hash(password, 10),
          passwordChangedAt: new Date(),
          // A generated password was printed to a terminal — the user picks their own.
          mustChangePassword: !provided,
          ...(activate ? { isActive: true } : {}),
        },
      });
      await tx.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
      if (makeAdmin) {
        const role = await tx.role.upsert({ where: { key: 'admin' }, update: {}, create: { key: 'admin' } });
        await tx.userRole.upsert({
          where: { userId_roleId: { userId: user.id, roleId: role.id } },
          update: {},
          create: { userId: user.id, roleId: role.id },
        });
      }
      await tx.auditLog.create({
        data: {
          actor: 'cli',
          action: 'user.password.reset',
          entity: 'user',
          entityId: user.id,
          metadata: { email: user.email, via: 'cli', grantedAdmin: makeAdmin, activated: activate },
        },
      });
    });
    console.log(`✓ Password reset for ${user.email}${makeAdmin ? ' (admin granted)' : ''}. All sessions revoked.`);
    if (!provided) console.log(`  New password (shown once): ${password}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('✗ Reset failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
