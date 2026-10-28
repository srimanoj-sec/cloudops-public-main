/**
 * Where to go after signing in: the page the user was sent here from, if it is
 * an in-app path. Anything else (absolute or protocol-relative URLs, the login
 * page itself) falls back to the dashboard, so this can't be an open redirect.
 */
export function returnPath(state: unknown): string {
  const from = (state as { from?: unknown } | null)?.from;
  if (typeof from !== 'string' || !from.startsWith('/') || from.startsWith('//') || from.startsWith('/\\')) return '/';
  if (from === '/login' || from.startsWith('/login?')) return '/';
  return from;
}
