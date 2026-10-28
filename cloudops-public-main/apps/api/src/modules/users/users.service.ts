import bcrypt from 'bcryptjs';
import { permissionsFor, type AdminUserDto, type CreateUserInput, type UpdateUserInput } from '@cloudops/core';
import { AppError } from '../../http/errors.js';
import type { AuditActor, AuditService } from '../audit/audit.service.js';
import type { AuthRepository } from '../auth/auth.repository.js';
import type { LocalJwtAuthProvider, UserWithRoles } from '../auth/auth.service.js';

function toAdminDto(u: UserWithRoles): AdminUserDto {
  const roles = u.roles.map((r) => r.role.key).sort();
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    roles,
    permissions: permissionsFor(roles),
    isActive: u.isActive,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    mustChangePassword: u.mustChangePassword,
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
  };
}

/**
 * User administration (admin only). Guard rails keep the platform manageable:
 * you can't lock yourself out, and there is always at least one active admin.
 */
export class UsersService {
  constructor(
    private readonly repo: AuthRepository,
    private readonly auth: LocalJwtAuthProvider,
    private readonly audit: AuditService,
  ) {}

  /** Active users' names — for assignee pickers and @mentions. */
  async directory(): Promise<{ id: string; name: string }[]> {
    const users = (await this.repo.listUsers()) as UserWithRoles[];
    return users.filter((u) => u.isActive).map((u) => ({ id: u.id, name: u.name || u.email.split('@')[0]! }));
  }

  async list(): Promise<AdminUserDto[]> {
    const users = (await this.repo.listUsers()) as UserWithRoles[];
    return users.map(toAdminDto);
  }

  async create(input: CreateUserInput, actor: AuditActor | null): Promise<AdminUserDto> {
    if (await this.repo.findUserByEmail(input.email)) throw AppError.conflict('A user with this email already exists');
    const user = (await this.repo.createUser({
      email: input.email,
      name: input.name,
      passwordHash: await bcrypt.hash(input.password, 10),
      roleKeys: [...new Set(input.roles)],
      mustChangePassword: true,
    })) as UserWithRoles;
    await this.audit.record({
      action: 'user.create',
      entity: 'user',
      entityId: user.id,
      actor,
      metadata: { email: user.email, roles: input.roles },
    });
    return toAdminDto(user);
  }

  async update(id: string, input: UpdateUserInput, actor: AuditActor | null): Promise<AdminUserDto> {
    const existing = (await this.repo.findUserById(id)) as UserWithRoles | null;
    if (!existing) throw AppError.notFound('User not found');
    const self = actor?.id === id;
    const wasAdmin = existing.roles.some((r) => r.role.key === 'admin');
    const willBeAdmin = input.roles ? input.roles.includes('admin') : wasAdmin;
    const willBeActive = input.isActive ?? existing.isActive;

    if (self && input.isActive === false) throw AppError.conflict('You cannot deactivate your own account');
    if (self && wasAdmin && !willBeAdmin) throw AppError.conflict('You cannot remove your own admin role');
    if (wasAdmin && existing.isActive && (!willBeAdmin || !willBeActive)) {
      if ((await this.repo.countActiveAdmins(id)) === 0) {
        throw AppError.conflict('At least one active admin is required');
      }
    }

    const updated = (await this.repo.updateUser(id, {
      name: input.name,
      isActive: input.isActive,
      roleKeys: input.roles ? [...new Set(input.roles)] : undefined,
    })) as UserWithRoles;
    if (input.isActive === false) await this.repo.revokeAllSessions(id);
    this.auth.invalidate(id);

    await this.audit.record({
      action: input.isActive === false ? 'user.deactivate' : input.isActive === true && !existing.isActive ? 'user.activate' : 'user.update',
      entity: 'user',
      entityId: id,
      actor,
      metadata: {
        email: existing.email,
        ...(input.roles ? { roles: { from: existing.roles.map((r) => r.role.key).sort(), to: [...input.roles].sort() } } : {}),
        ...(input.name !== undefined && input.name !== existing.name ? { name: { from: existing.name, to: input.name } } : {}),
      },
    });
    return toAdminDto(updated);
  }

  async resetPassword(id: string, password: string, actor: AuditActor | null): Promise<void> {
    const existing = await this.repo.findUserById(id);
    if (!existing) throw AppError.notFound('User not found');
    await this.auth.resetPassword(id, password);
    await this.audit.record({
      action: 'user.password.reset',
      entity: 'user',
      entityId: id,
      actor,
      metadata: { email: existing.email },
    });
  }
}
