import type { ReactNode } from 'react';
import { ShieldAlert } from 'lucide-react';
import { PERMISSIONS, type Permission } from '@cloudops/core';
import { usePermissions } from '../../lib/auth';
import { EmptyState } from '../../components/ui/primitives';

/** Renders a restricted page; everyone else gets a clear permission state (not a broken page). */
export function AdminGate({ permission, children }: { permission: Permission; children: ReactNode }) {
  const { can } = usePermissions();
  if (can(permission)) return <>{children}</>;
  return (
    <EmptyState
      icon={ShieldAlert}
      title="You don’t have access to this page"
      description={`It needs the “${PERMISSIONS[permission]}” permission. Ask an administrator if you need it.`}
    />
  );
}
