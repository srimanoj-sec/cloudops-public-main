import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { WorkItemDialog, type FixedScope, type WorkDefaults } from './shared';

export interface CreateWorkOptions {
  defaults?: WorkDefaults;
  source?: { type: string; id: string; label?: string };
  scopes?: FixedScope[];
}

const CreateWorkContext = createContext<((opts?: CreateWorkOptions) => void) | null>(null);

/**
 * One "create work item" dialog for the whole app. Anything that surfaces a
 * problem — a priority item, a finding, an anomaly, a drift event, a failed
 * sync — opens it with the origin and affected scopes pre-filled, so the work
 * item links back to what raised it.
 */
export function CreateWorkProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<CreateWorkOptions | null>(null);
  const start = useCallback((opts?: CreateWorkOptions) => setOpen(opts ?? {}), []);
  const value = useMemo(() => start, [start]);
  return (
    <CreateWorkContext.Provider value={value}>
      {children}
      {open && (
        <WorkItemDialog
          defaults={open.defaults}
          source={open.source}
          scopes={open.scopes}
          onClose={() => setOpen(null)}
        />
      )}
    </CreateWorkContext.Provider>
  );
}

export function useCreateWork(): (opts?: CreateWorkOptions) => void {
  const ctx = useContext(CreateWorkContext);
  if (!ctx) throw new Error('useCreateWork must be used within CreateWorkProvider');
  return ctx;
}
