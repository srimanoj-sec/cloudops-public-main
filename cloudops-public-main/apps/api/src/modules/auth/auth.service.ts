import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createHash, randomUUID } from 'node:crypto';
import {
  permissionsFor,
  type AuthTokens,
  type LoginResponse,
  type SessionDto,
  type UserDto,
} from '@cloudops/core';
import { DEFAULT_SEED_PASSWORD, config } from '../../env.js';
import { AppError } from '../../http/errors.js';
import type { AuditActor, AuditService } from '../audit/audit.service.js';
import type { AuthProvider, AuthenticatedUser } from './auth.provider.js';
import type { AuthRepository } from './auth.repository.js';

export type UserWithRoles = {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  isActive: boolean;
  lastLoginAt: Date | null;
  passwordChangedAt: Date | null;
  sessionsValidAfter?: Date | null;
  mustChangePassword: boolean;
  createdAt: Date;
  updatedAt: Date;
  roles: { role: { key: string } }[];
};

interface AccessClaims {
  sub: string;
  email: string;
  roles: string[];
  /** The session (refresh-token family member) issued with it. */
  sid?: string;
  /** Issued-at in milliseconds — `iat` is whole seconds, too coarse for "sign out everywhere" cutoffs. */
  ims?: number;
  iat?: number;
}
interface RefreshClaims {
  sub: string;
  sid: string;
}

/** What the request path needs to authorize a token — cached briefly per user. */
interface AuthState {
  active: boolean;
  email: string;
  name: string;
  roles: string[];
  createdAt: string;
  mustChangePassword: boolean;
  /** Tokens issued before this instant (epoch ms) are rejected. */
  notBeforeMs: number;
}

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
/** Pin the algorithm on both sides — never let a token choose how it is verified. */
const JWT_ALGORITHM = 'HS256' as const;
const VERIFY: jwt.VerifyOptions = { algorithms: [JWT_ALGORITHM] };
const BCRYPT_ROUNDS = 10;
/** How long a user's active/roles state is trusted before re-reading the DB. */
const AUTH_STATE_TTL_MS = 30_000;
/**
 * Compared against when the email is unknown, so a failed login costs the same
 * bcrypt work either way and response time doesn't reveal which emails exist.
 */
const DUMMY_HASH = bcrypt.hashSync('cloudops-timing-equalizer', BCRYPT_ROUNDS);

/** A readable device label from a user agent — never shown raw in lists. */
export function describeUserAgent(ua: string | null | undefined): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : null;
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad|iOS/.test(ua)
        ? 'iOS'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  if (browser) return os ? `${browser} on ${os}` : browser;
  if (/node|undici|curl|python|axios|go-http|PowerShell/i.test(ua)) return 'API client';
  return os ?? 'Unknown device';
}

/** Local JWT implementation of the AuthProvider seam. */
export class LocalJwtAuthProvider implements AuthProvider {
  readonly kind = 'local-jwt';
  private readonly stateCache = new Map<string, { expires: number; state: AuthState | null }>();

  constructor(
    private readonly repo: AuthRepository,
    private readonly audit?: AuditService,
  ) {}

  /** Admin-only since the Users page exists (the route enforces it). New accounts are viewers. */
  async register(
    input: { email: string; password: string; name: string },
    actor?: AuditActor | null,
  ): Promise<UserDto> {
    const existing = await this.repo.findUserByEmail(input.email);
    if (existing) throw AppError.conflict('Email already registered');
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    const user = (await this.repo.createUser({
      email: input.email,
      name: input.name,
      passwordHash,
      roleKeys: ['viewer'],
    })) as UserWithRoles;
    await this.audit?.record({
      action: 'user.create',
      entity: 'user',
      entityId: user.id,
      actor,
      metadata: { email: user.email, roles: ['viewer'], via: 'register' },
    });
    return toDto(user);
  }

  async login(
    input: { email: string; password: string },
    userAgent?: string,
  ): Promise<LoginResponse> {
    const email = input.email.trim().toLowerCase();
    const user = ((await this.repo.findUserByEmail(email)) ??
      (await this.repo.findUserByEmail(input.email))) as UserWithRoles | null;
    // Always pay for one bcrypt comparison (timing-safe against email probing).
    const valid = await bcrypt.compare(input.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !user.isActive || !valid) {
      await this.audit?.record({
        action: 'auth.login.failed',
        entity: 'user',
        entityId: user?.id ?? null,
        actor: user ? { id: user.id, name: user.email } : { name: email },
        metadata: {
          reason: !user ? 'unknown_email' : !user.isActive ? 'account_disabled' : 'bad_password',
        },
      });
      throw AppError.unauthorized('Invalid credentials');
    }

    // Still on the documented first-boot password? Treat it like an admin-set one.
    const current =
      !user.mustChangePassword && input.password === DEFAULT_SEED_PASSWORD
        ? ((await this.repo.requirePasswordChange(user.id)) as UserWithRoles)
        : user;
    if (current !== user) this.invalidate(user.id);
    const tokens = await this.issueTokens(current, userAgent);
    await this.repo.touchLogin(user.id);
    await this.audit?.record({
      action: 'auth.login',
      entity: 'user',
      entityId: user.id,
      actor: { id: user.id, name: user.name || user.email },
    });
    return { user: toDto(current), tokens };
  }

  async refresh(refreshToken: string, userAgent?: string): Promise<AuthTokens> {
    let claims: RefreshClaims;
    try {
      claims = jwt.verify(refreshToken, config.JWT_REFRESH_SECRET, VERIFY) as RefreshClaims;
    } catch {
      throw AppError.unauthorized('Invalid refresh token');
    }
    const session = await this.repo.findSession(claims.sid);
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      throw AppError.unauthorized('Session expired');
    }
    if (session.refreshTokenHash !== sha256(refreshToken)) {
      // Token reuse / mismatch — revoke defensively.
      await this.repo.revokeSession(session.id);
      throw AppError.unauthorized('Invalid refresh token');
    }
    const user = (await this.repo.findUserById(claims.sub)) as UserWithRoles | null;
    if (!user || !user.isActive) throw AppError.unauthorized('User not found');

    // Rotate. Atomic: of two concurrent refreshes with the same token, exactly one wins.
    if (!(await this.repo.revokeSessionIfActive(session.id)))
      throw AppError.unauthorized('Session expired');
    return this.issueTokens(user, userAgent);
  }

  /**
   * End the session behind a refresh token. Idempotent and quiet: an already
   * revoked/expired/unknown token is not an error (logout must always succeed).
   */
  async logout(refreshToken: string): Promise<void> {
    let claims: RefreshClaims;
    try {
      claims = jwt.verify(refreshToken, config.JWT_REFRESH_SECRET, {
        ...VERIFY,
        ignoreExpiration: true,
      }) as RefreshClaims;
    } catch {
      return;
    }
    const session = await this.repo.findSession(claims.sid);
    if (!session || session.revokedAt || session.refreshTokenHash !== sha256(refreshToken)) return;
    await this.repo.revokeSession(session.id);
    const user = await this.repo.findUserById(claims.sub);
    await this.audit?.record({
      action: 'auth.logout',
      entity: 'user',
      entityId: claims.sub,
      actor: { id: claims.sub, name: user?.name || user?.email },
    });
  }

  /**
   * Change your own password. Every existing session (on every device) is
   * revoked; the caller gets a fresh session so this browser stays signed in.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    userAgent?: string,
  ): Promise<LoginResponse> {
    const user = (await this.repo.findUserById(userId)) as UserWithRoles | null;
    if (!user || !user.isActive) throw AppError.unauthorized('User not found');
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw new AppError(400, 'Current password is incorrect', 'invalid_current_password');
    }
    if (await bcrypt.compare(newPassword, user.passwordHash)) {
      throw new AppError(
        400,
        'Choose a password different from the current one',
        'password_unchanged',
      );
    }
    const updated = (await this.repo.setPassword(
      userId,
      await bcrypt.hash(newPassword, BCRYPT_ROUNDS),
    )) as UserWithRoles;
    await this.repo.revokeAllSessions(userId);
    this.invalidate(userId);
    const tokens = await this.issueTokens(updated, userAgent);
    await this.audit?.record({
      action: 'auth.password.change',
      entity: 'user',
      entityId: userId,
      actor: { id: userId, name: user.name || user.email },
    });
    return { user: toDto(updated), tokens };
  }

  /** A user's signed-in devices. `currentSid` marks the one making the request. */
  async listSessions(userId: string, currentSid?: string): Promise<SessionDto[]> {
    const rows = await this.repo.activeSessions(userId);
    return rows.map((s) => ({
      id: s.id,
      device: describeUserAgent(s.userAgent),
      userAgent: s.userAgent,
      lastActiveAt: s.createdAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      current: s.id === currentSid,
    }));
  }

  /**
   * End one of your own sessions: that device can't renew its tokens, so it is
   * signed out when its short-lived access token expires (JWT_ACCESS_TTL).
   */
  async revokeOwnSession(
    userId: string,
    sessionId: string,
    actor: AuditActor | null,
  ): Promise<void> {
    const session = await this.repo.findSession(sessionId);
    if (!session || session.userId !== userId) throw AppError.notFound('Session not found');
    if (session.revokedAt) return;
    await this.repo.revokeSession(sessionId);
    await this.audit?.record({
      action: 'auth.session.revoke',
      entity: 'user',
      entityId: userId,
      actor,
      metadata: { device: describeUserAgent(session.userAgent) },
    });
  }

  /**
   * Sign a user out everywhere, immediately: every session is revoked and every
   * access token issued before now is rejected. With `keep` (self-service "sign
   * out other devices"), the caller gets a fresh session so this browser stays in.
   */
  async signOutEverywhere(
    userId: string,
    actor: AuditActor | null,
    keep?: { userAgent?: string },
  ): Promise<LoginResponse | null> {
    const user = (await this.repo.findUserById(userId)) as UserWithRoles | null;
    if (!user) throw AppError.notFound('User not found');
    await this.repo.revokeAllSessions(userId);
    await this.repo.setSessionsValidAfter(userId, new Date());
    this.invalidate(userId);
    await this.audit?.record({
      action: keep ? 'auth.session.revoke-others' : 'auth.session.revoke-all',
      entity: 'user',
      entityId: userId,
      actor,
    });
    if (!keep || !user.isActive) return null;
    // Issued after the cutoff (millisecond precision), so this one stays valid.
    const tokens = await this.issueTokens(user, keep.userAgent);
    return { user: toDto(user), tokens };
  }

  /** Admin reset: set a new password and sign the user out everywhere. */
  async resetPassword(userId: string, newPassword: string): Promise<void> {
    await this.repo.setPassword(userId, await bcrypt.hash(newPassword, BCRYPT_ROUNDS), true);
    await this.repo.revokeAllSessions(userId);
    this.invalidate(userId);
  }

  async me(userId: string): Promise<UserDto> {
    const user = (await this.repo.findUserById(userId)) as UserWithRoles | null;
    if (!user) throw AppError.notFound('User not found');
    return toDto(user);
  }

  /**
   * Verify an access token AND that its user may still act: the account must
   * exist and be active, and the token must post-date the last password change.
   * Roles come from the database (cached {@link AUTH_STATE_TTL_MS}), so a role
   * change or deactivation takes effect within seconds, not at token expiry.
   */
  async verifyAccessToken(token: string): Promise<AuthenticatedUser> {
    let claims: AccessClaims;
    try {
      claims = jwt.verify(token, config.JWT_ACCESS_SECRET, VERIFY) as AccessClaims;
    } catch {
      throw AppError.unauthorized('Invalid or expired token');
    }
    const state = await this.authState(claims.sub);
    if (!state || !state.active)
      throw AppError.unauthorized('This account is disabled or no longer exists');
    // Tokens from before `ims` existed only know the second — treat them as issued at its start.
    if ((claims.ims ?? (claims.iat ?? 0) * 1000) < state.notBeforeMs)
      throw AppError.unauthorized('Session expired — sign in again');
    return {
      id: claims.sub,
      email: state.email,
      name: state.name,
      roles: state.roles,
      permissions: permissionsFor(state.roles),
      createdAt: state.createdAt,
      mustChangePassword: state.mustChangePassword,
      ...(claims.sid ? { sessionId: claims.sid } : {}),
    };
  }

  /** Drop a user's cached auth state (after role/active/password changes). */
  invalidate(userId: string): void {
    this.stateCache.delete(userId);
  }

  private async authState(userId: string): Promise<AuthState | null> {
    const hit = this.stateCache.get(userId);
    if (hit && hit.expires > Date.now()) return hit.state;
    const user = (await this.repo.findUserById(userId)) as UserWithRoles | null;
    const state: AuthState | null = user
      ? {
          active: user.isActive,
          email: user.email,
          name: user.name,
          roles: user.roles.map((r) => r.role.key),
          createdAt: user.createdAt.toISOString(),
          mustChangePassword: user.mustChangePassword,
          notBeforeMs: Math.max(
            user.passwordChangedAt?.getTime() ?? 0,
            user.sessionsValidAfter?.getTime() ?? 0,
          ),
        }
      : null;
    this.stateCache.set(userId, { expires: Date.now() + AUTH_STATE_TTL_MS, state });
    return state;
  }

  private async issueTokens(user: UserWithRoles, userAgent?: string): Promise<AuthTokens> {
    const roles = user.roles.map((r) => r.role.key);
    const sid = randomUUID();
    const accessToken = jwt.sign(
      { sub: user.id, email: user.email, roles, sid, ims: Date.now() } satisfies AccessClaims,
      config.JWT_ACCESS_SECRET,
      {
        algorithm: JWT_ALGORITHM,
        expiresIn: config.JWT_ACCESS_TTL,
      } as jwt.SignOptions,
    );

    const refreshToken = jwt.sign(
      { sub: user.id, sid } satisfies RefreshClaims,
      config.JWT_REFRESH_SECRET,
      {
        algorithm: JWT_ALGORITHM,
        expiresIn: config.JWT_REFRESH_TTL,
      } as jwt.SignOptions,
    );

    const decoded = jwt.decode(refreshToken) as { exp: number };
    await this.repo.createSession({
      id: sid, // session id equals the sid embedded in the refresh token
      userId: user.id,
      refreshTokenHash: sha256(refreshToken),
      expiresAt: new Date(decoded.exp * 1000),
      userAgent: userAgent?.slice(0, 500),
    });

    const accessDecoded = jwt.decode(accessToken) as { exp: number; iat: number };
    return {
      accessToken,
      refreshToken,
      expiresIn: accessDecoded.exp - accessDecoded.iat,
    };
  }
}

export function toDto(user: UserWithRoles): UserDto {
  const roles = user.roles.map((r) => r.role.key);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    roles,
    permissions: permissionsFor(roles),
    createdAt: user.createdAt.toISOString(),
    mustChangePassword: user.mustChangePassword,
  };
}
