import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * Global organization (Entra tenant) scope. A single source of truth shared by
 * the header switcher and every org-aware page (dashboard, inventory, cost,
 * topology, work). Empty string = "All organizations". Persisted to localStorage.
 */
interface OrgContextValue {
  tenantId: string;
  setTenantId: (id: string) => void;
}

const OrgContext = createContext<OrgContextValue | null>(null);
const STORAGE_KEY = 'cloudops.org';

export function OrgProvider({ children }: { children: ReactNode }) {
  const [tenantId, setTenantIdState] = useState<string>(() => localStorage.getItem(STORAGE_KEY) ?? '');

  const value = useMemo<OrgContextValue>(
    () => ({
      tenantId,
      setTenantId: (id: string) => {
        setTenantIdState(id);
        if (id) localStorage.setItem(STORAGE_KEY, id);
        else localStorage.removeItem(STORAGE_KEY);
      },
    }),
    [tenantId],
  );

  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}

export function useOrg(): OrgContextValue {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error('useOrg must be used within OrgProvider');
  return ctx;
}
