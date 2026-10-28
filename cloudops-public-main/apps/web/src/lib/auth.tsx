import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { LoginResponse, Permission, UserDto } from '@cloudops/core';
import {
  SESSION_EXPIRED_EVENT,
  TOKEN_STORAGE_KEYS,
  api,
  apiErrorMessage,
  isAuthRejection,
  tokenStore,
} from './api';

/** Why the user was sent to the login page (shown there). */
export type SignOutReason = 'expired' | null;
const REASON_KEY = 'cloudops.signout-reason';

interface AuthContextValue {
  user: UserDto | null;
  loading: boolean;
  /** The session couldn't be verified because the API was unreachable (not rejected). */
  bootError: string | null;
  retryBootstrap: () => void;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  /** Change your own password; keeps this browser signed in with a fresh session. */
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  /** Sign out every other device immediately; this browser gets a fresh session. */
  signOutOtherDevices: () => Promise<void>;
  /** Consume (read + clear) why the last session ended. */
  takeSignOutReason: () => SignOutReason;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [user, setUser] = useState<UserDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [bootAttempt, setBootAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    async function bootstrap() {
      if (!tokenStore.access && !tokenStore.refresh) {
        setLoading(false);
        return;
      }
      setLoading(true);
      setBootError(null);
      try {
        const { data } = await api.get<UserDto>('/api/auth/me');
        if (active) setUser(data);
      } catch (err) {
        // Only a rejection of the credentials ends the session. If the API is
        // restarting or the network is down, keep the tokens and offer a retry —
        // reloading during a blip must not sign anyone out.
        if (isAuthRejection(err) || !tokenStore.refresh) tokenStore.clear();
        else if (active) setBootError(apiErrorMessage(err));
      } finally {
        if (active) setLoading(false);
      }
    }
    void bootstrap();
    return () => {
      active = false;
    };
  }, [bootAttempt]);

  const retryBootstrap = useCallback(() => setBootAttempt((n) => n + 1), []);

  // Tokens are shared by every tab: follow sign-outs (and sign-ins) done elsewhere.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.storageArea !== localStorage || (e.key !== null && !TOKEN_STORAGE_KEYS.includes(e.key)))
        return;
      if (!tokenStore.refresh) {
        setUser(null);
        qc.clear();
      } else if (!user) {
        retryBootstrap();
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [qc, user, retryBootstrap]);

  // The API client signals when a session can't be renewed: sign out cleanly
  // (with an explanation on the login page) instead of leaving every panel erroring.
  useEffect(() => {
    const onExpired = () => {
      sessionStorage.setItem(REASON_KEY, 'expired');
      setUser(null);
      qc.clear();
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, [qc]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      bootError,
      retryBootstrap,
      async login(email, password) {
        const { data } = await api.post<LoginResponse>('/api/auth/login', { email, password });
        tokenStore.set(data.tokens);
        sessionStorage.removeItem(REASON_KEY);
        setUser(data.user);
      },
      logout() {
        // Revoke the server-side session too (best-effort — never blocks sign-out).
        const refreshToken = tokenStore.refresh;
        if (refreshToken)
          void api.post('/api/auth/logout', { refreshToken }).catch(() => undefined);
        tokenStore.clear();
        qc.clear();
        setUser(null);
      },
      async changePassword(currentPassword, newPassword) {
        const { data } = await api.post<LoginResponse>('/api/auth/password', {
          currentPassword,
          newPassword,
        });
        tokenStore.set(data.tokens);
        setUser(data.user);
      },
      async signOutOtherDevices() {
        const { data } = await api.post<LoginResponse>('/api/auth/sessions/revoke-others');
        tokenStore.set(data.tokens);
        setUser(data.user);
        void qc.invalidateQueries({ queryKey: ['sessions'] });
      },
      takeSignOutReason() {
        const reason = sessionStorage.getItem(REASON_KEY) as SignOutReason;
        sessionStorage.removeItem(REASON_KEY);
        return reason;
      },
    }),
    [user, loading, bootError, retryBootstrap, qc],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

/**
 * Permission helpers — mirror the API's authorization (the caller's effective
 * permissions come with the user) so the UI never offers an action that would 403.
 */
export function usePermissions() {
  const { user } = useAuth();
  const granted = user?.permissions ?? [];
  const can = (permission: Permission) => granted.includes(permission);
  return { can, isAdmin: Boolean(user?.roles.includes('admin')) };
}
