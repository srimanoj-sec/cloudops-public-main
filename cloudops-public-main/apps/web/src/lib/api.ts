import axios, { AxiosError, type AxiosInstance } from 'axios';
import type { AuthTokens } from '@cloudops/core';

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

const ACCESS_KEY = 'cloudops.access';
const REFRESH_KEY = 'cloudops.refresh';

/** Fired when the refresh token can no longer renew the session (AuthProvider signs out). */
export const SESSION_EXPIRED_EVENT = 'cloudops:session-expired';

/** localStorage keys holding the session (watched for cross-tab sign-in/out). */
export const TOKEN_STORAGE_KEYS: readonly string[] = [ACCESS_KEY, REFRESH_KEY];

export const tokenStore = {
  get access() {
    return localStorage.getItem(ACCESS_KEY);
  },
  get refresh() {
    return localStorage.getItem(REFRESH_KEY);
  },
  set(tokens: AuthTokens) {
    localStorage.setItem(ACCESS_KEY, tokens.accessToken);
    localStorage.setItem(REFRESH_KEY, tokens.refreshToken);
  },
  clear() {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

/**
 * No request may hang forever: on a dead or very slow link the UI should say so
 * (and let the user retry) instead of spinning indefinitely. Downloads set their own.
 */
export const REQUEST_TIMEOUT_MS = 30_000;

export const api: AxiosInstance = axios.create({ baseURL: BASE_URL, timeout: REQUEST_TIMEOUT_MS });

api.interceptors.request.use((cfg) => {
  const token = tokenStore.access;
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

let refreshing: Promise<string | null> | null = null;

/** Web Locks name serializing token refresh across every tab of this origin. */
const REFRESH_LOCK = 'cloudops-token-refresh';

/**
 * Renew the access token. Tokens live in localStorage, shared by every tab, and
 * a refresh token is single-use — so tabs must not refresh concurrently: the
 * loser would be rejected and, worse, sign every tab out. The refresh runs under
 * a cross-tab lock, and whoever gets the lock first checks whether another tab
 * already rotated the pair while it waited.
 */
async function refreshAccessToken(): Promise<string | null> {
  const attempted = tokenStore.refresh;
  if (!attempted) return null;
  const run = () => refreshUnderLock(attempted);
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  return locks ? locks.request(REFRESH_LOCK, run) : run();
}

async function refreshUnderLock(attempted: string): Promise<string | null> {
  const current = tokenStore.refresh;
  if (!current) return null; // signed out (here or in another tab)
  if (current !== attempted) return tokenStore.access; // another tab already refreshed
  try {
    const { data } = await axios.post<AuthTokens>(
      `${BASE_URL}/api/auth/refresh`,
      { refreshToken: current },
      { timeout: REQUEST_TIMEOUT_MS },
    );
    tokenStore.set(data);
    return data.accessToken;
  } catch (err) {
    // Only a definitive rejection ends the session — a network blip must not log the user out.
    if (axios.isAxiosError(err) && err.response && err.response.status < 500) {
      // …and only if nobody rotated the tokens meanwhile (no Web Locks support).
      if (tokenStore.refresh !== current) return tokenStore.access;
      tokenStore.clear();
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
    }
    return null;
  }
}

api.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const original = error.config as (typeof error.config & { _retried?: boolean }) | undefined;
    if (error.response?.status === 401 && original && !original._retried && tokenStore.refresh) {
      original._retried = true;
      // Another tab may already have renewed the pair: just retry with it.
      const sent = String(original.headers?.Authorization ?? '').replace(/^Bearer /, '');
      const stored = tokenStore.access;
      if (stored && stored !== sent) {
        original.headers.Authorization = `Bearer ${stored}`;
        return api(original);
      }
      refreshing ??= refreshAccessToken().finally(() => (refreshing = null));
      const newToken = await refreshing;
      if (newToken) {
        original.headers = original.headers ?? {};
        original.headers.Authorization = `Bearer ${newToken}`;
        return api(original);
      }
    }
    return Promise.reject(error);
  },
);

interface ApiErrorBody {
  error?: { code?: string; message?: string; requestId?: string; retryAfterSeconds?: number };
}

/**
 * React Query retry policy: client errors (403, 404, 422…) won't fix themselves,
 * so fail straight to the error state; network trouble, timeouts, 5xx and 429
 * get two more tries with backoff.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;
  if (status !== undefined && status < 500 && status !== 408 && status !== 429) return false;
  return failureCount < 2;
}

/** True when the API rejected the credentials themselves (not a network/server problem). */
export function isAuthRejection(err: unknown): boolean {
  return axios.isAxiosError(err) && (err.response?.status === 401 || err.response?.status === 403);
}

/** Machine-readable error code from an API error (e.g. `rate_limited`), if any. */
export function apiErrorCode(err: unknown): string | undefined {
  return axios.isAxiosError(err) ? (err.response?.data as ApiErrorBody | undefined)?.error?.code : undefined;
}

/** Extract a human-readable message from an API error. */
export function apiErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    if (!err.response) {
      return err.code === 'ECONNABORTED'
        ? 'The request timed out. Please try again.'
        : 'Can’t reach the CloudOps API. Check your connection or that the server is running.';
    }
    const body = err.response.data as ApiErrorBody | undefined;
    const message = body?.error?.message;
    if (err.response.status >= 500) {
      const ref = body?.error?.requestId ? ` (reference ${body.error.requestId.slice(0, 8)})` : '';
      return `${message ?? 'Something went wrong on our side. Please try again.'}${ref}`;
    }
    return message ?? err.message;
  }
  return err instanceof Error ? err.message : 'Unexpected error';
}

/** Download an authenticated file (e.g. CSV export) and hand it to the browser. */
export async function downloadFile(path: string, params: Record<string, unknown>, fallbackName: string): Promise<void> {
  let res;
  try {
    // Large exports on a slow link legitimately take a while.
    res = await api.get<Blob>(path, { params, responseType: 'blob', timeout: 5 * 60_000 });
  } catch (err) {
    // With responseType 'blob' an error body arrives as a Blob — decode it so the
    // caller gets the API's message (e.g. rate limited) instead of "Error 429".
    if (axios.isAxiosError(err) && err.response?.data instanceof Blob) {
      try {
        err.response.data = JSON.parse(await err.response.data.text());
      } catch {
        /* not JSON — keep the generic message */
      }
    }
    throw err;
  }
  const disposition = String(res.headers['content-disposition'] ?? '');
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
