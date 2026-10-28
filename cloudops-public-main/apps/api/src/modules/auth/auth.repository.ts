import type { Prisma } from '../../infra/prisma.js';

const withRoles = { roles: { include: { role: true } } } as const;

export class AuthRepository {
  constructor(private readonly prisma: Prisma) {}

  findUserByEmail(email: string) {
    return this.prisma.user.findUnique({ where: { email }, include: withRoles });
  }

  findUserById(id: string) {
    return this.prisma.user.findUnique({ where: { id }, include: withRoles });
  }

  listUsers() {
    return this.prisma.user.findMany({
      include: withRoles,
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
  }

  async createUser(input: {
    email: string;
    name: string;
    passwordHash: string;
    roleKeys: string[];
    mustChangePassword?: boolean;
  }) {
    return this.prisma.user.create({
      data: {
        email: input.email,
        name: input.name,
        passwordHash: input.passwordHash,
        mustChangePassword: input.mustChangePassword ?? false,
        roles: {
          create: input.roleKeys.map((key) => ({
            role: {
              connectOrCreate: { where: { key }, create: { key } },
            },
          })),
        },
      },
      include: withRoles,
    });
  }

  /** Update profile fields and (optionally) replace the role set atomically. */
  async updateUser(id: string, data: { name?: string; isActive?: boolean; roleKeys?: string[] }) {
    return this.prisma.$transaction(async (tx) => {
      if (data.roleKeys) {
        await tx.userRole.deleteMany({ where: { userId: id } });
        for (const key of data.roleKeys) {
          const role = await tx.role.upsert({ where: { key }, update: {}, create: { key } });
          await tx.userRole.create({ data: { userId: id, roleId: role.id } });
        }
      }
      return tx.user.update({
        where: { id },
        data: {
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        },
        include: withRoles,
      });
    });
  }

  /** `mustChange`: the password was set by someone else (admin reset). */
  setPassword(id: string, passwordHash: string, mustChange = false) {
    return this.prisma.user.update({
      where: { id },
      data: { passwordHash, passwordChangedAt: new Date(), mustChangePassword: mustChange },
      include: withRoles,
    });
  }

  requirePasswordChange(id: string) {
    return this.prisma.user.update({
      where: { id },
      data: { mustChangePassword: true },
      include: withRoles,
    });
  }

  touchLogin(id: string) {
    return this.prisma.user.update({ where: { id }, data: { lastLoginAt: new Date() } });
  }

  /** Active users holding the admin role, optionally excluding one. */
  countActiveAdmins(excludeUserId?: string) {
    return this.prisma.user.count({
      where: {
        isActive: true,
        roles: { some: { role: { key: 'admin' } } },
        ...(excludeUserId ? { id: { not: excludeUserId } } : {}),
      },
    });
  }

  createSession(input: {
    id: string;
    userId: string;
    refreshTokenHash: string;
    expiresAt: Date;
    userAgent?: string;
  }) {
    return this.prisma.session.create({ data: input });
  }

  findSession(id: string) {
    return this.prisma.session.findUnique({ where: { id } });
  }

  revokeSession(id: string) {
    return this.prisma.session.update({ where: { id }, data: { revokedAt: new Date() } });
  }

  /**
   * Atomically revoke a session only if it is still live. Returns false when a
   * concurrent request already rotated/revoked it — a refresh token is single-use.
   */
  async revokeSessionIfActive(id: string): Promise<boolean> {
    const r = await this.prisma.session.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return r.count === 1;
  }

  /** Revoke every live session of a user (password change, reset, deactivation). */
  revokeAllSessions(userId: string) {
    return this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** A user's live sessions, most recently active first. */
  activeSessions(userId: string) {
    return this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, userAgent: true, createdAt: true, expiresAt: true },
    });
  }

  /** "Sign out everywhere": access tokens issued before now stop working. */
  setSessionsValidAfter(userId: string, at: Date) {
    return this.prisma.user.update({ where: { id: userId }, data: { sessionsValidAfter: at } });
  }

  /** Delete sessions that expired or were revoked before `before`. Returns the count removed. */
  async purgeSessions(before: Date): Promise<number> {
    const r = await this.prisma.session.deleteMany({
      where: { OR: [{ expiresAt: { lt: before } }, { revokedAt: { lt: before } }] },
    });
    return r.count;
  }
}
