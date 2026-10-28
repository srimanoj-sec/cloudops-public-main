import { z } from 'zod';
import { ROLES } from './enums.js';

export const loginSchema = z.object({
  email: z.string().email(),
  // bcrypt only reads 72 bytes; the cap stops absurd payloads reaching it.
  password: z.string().min(1).max(256),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().min(1).max(120),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshInput = z.infer<typeof refreshSchema>;

export interface UserDto {
  id: string;
  email: string;
  name: string;
  roles: string[];
  /** Effective permissions of the roles (see permissions.ts) — what the UI may offer. */
  permissions: string[];
  createdAt: string;
  /** The password was set by an admin (or is the seeded default) — prompt the user to choose their own. */
  mustChangePassword: boolean;
}

/** One signed-in device/browser. Sessions rotate on every token refresh. */
export interface SessionDto {
  id: string;
  /** "Chrome on Windows", "API client"… — from the user agent. */
  device: string;
  userAgent: string | null;
  /** When it last refreshed its tokens (roughly: last active, within the access-token lifetime). */
  lastActiveAt: string;
  expiresAt: string;
  /** The session making this request. */
  current: boolean;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface LoginResponse {
  user: UserDto;
  tokens: AuthTokens;
}

export type {}; // ensure module

export const RoleValues = ROLES;

// ── Sessions & passwords ─────────────────────────────────────────────

/** Policy for any NEW password (change, reset, admin-created user). */
/** UTF-8 byte length (what bcrypt sees) — no TextEncoder, so it type-checks in every package. */
export function utf8Length(value: string): number {
  let bytes = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(72, 'Use at most 72 characters')
  // bcrypt ignores everything past 72 BYTES — a longer (e.g. emoji-heavy)
  // password would silently match any other with the same prefix.
  .refine(
    (v) => utf8Length(v) <= 72,
    'Too long — use at most 72 bytes (fewer non-Latin characters)',
  );

export const logoutSchema = z.object({
  refreshToken: z.string().min(1),
});
export type LogoutInput = z.infer<typeof logoutSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

// ── User administration (admin only) ─────────────────────────────────

const roleSchema = z.enum(ROLES);

export const createUserSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(1).max(120),
  password: passwordSchema,
  roles: z.array(roleSchema).min(1, 'Pick at least one role').max(ROLES.length),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    roles: z.array(roleSchema).min(1, 'Pick at least one role').max(ROLES.length).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const resetPasswordSchema = z.object({
  password: passwordSchema,
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

/** A user as seen on the Users admin page. */
export interface AdminUserDto extends UserDto {
  isActive: boolean;
  lastLoginAt: string | null;
  updatedAt: string;
}

// ── Audit log ────────────────────────────────────────────────────────

export const auditQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  /** Action prefix, e.g. `auth.` or `provider.account.` */
  action: z.string().trim().max(100).optional(),
  entity: z.string().trim().max(100).optional(),
  entityId: z.string().trim().max(200).optional(),
  actorId: z.string().trim().max(100).optional(),
  /** Every event recorded while serving one API request (correlation id). */
  requestId: z.string().trim().max(100).optional(),
  /** Free-text over actor + action + entity. */
  search: z.string().trim().max(200).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

/** Someone who appears in the audit log (for the actor filter). */
export interface AuditActorDto {
  actorId: string;
  actor: string | null;
  events: number;
}

export interface AuditLogDto {
  id: string;
  actor: string | null;
  actorId: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  metadata: unknown;
  ip: string | null;
  requestId: string | null;
  createdAt: string;
}
