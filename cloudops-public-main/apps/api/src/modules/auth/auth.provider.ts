import type { UserDto } from '@cloudops/core';

/**
 * AuthProvider seam — isolates the authentication mechanism so Microsoft Entra
 * ID (OIDC) can be dropped in later (`EntraOidcAuthProvider`) without reworking
 * callers. The skeleton ships `LocalJwtAuthProvider`.
 */
export type AuthenticatedUser = UserDto & {
  /** The session the access token belongs to (tokens issued before sessions were tracked have none). */
  sessionId?: string;
};

export interface AuthProvider {
  readonly kind: string;
  /** Verify an access token and return the authenticated user. */
  verifyAccessToken(token: string): Promise<AuthenticatedUser>;
}
