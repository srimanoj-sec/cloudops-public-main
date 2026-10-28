import { useState } from 'react';
import { LogOut, MonitorSmartphone } from 'lucide-react';
import type { SessionDto } from '@cloudops/core';
import { useAuth } from '../../lib/auth';
import { apiErrorMessage } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { useMySessions, useRevokeSession } from '../../lib/queries';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  IconButton,
  LoadingBlock,
} from '../../components/ui/primitives';
import { Modal } from '../../components/ui/Modal';
import { useConfirm } from '../../components/ui/Dialogs';
import { useToast } from '../../components/ui/Toast';

/** One device row — shared by "your devices" and the admin view of a user. */
export function SessionRow({
  s,
  onRevoke,
  busy,
}: {
  s: SessionDto;
  onRevoke?: () => void;
  busy?: boolean;
}) {
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <MonitorSmartphone className="size-4 shrink-0 text-fg-muted" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-body-sm font-medium text-fg">{s.device}</span>
          {s.current && <Badge tone="accent">This browser</Badge>}
        </div>
        <div className="text-caption text-fg-muted" title={s.userAgent ?? undefined}>
          Active {timeAgo(s.lastActiveAt)} · expires {new Date(s.expiresAt).toLocaleDateString()}
        </div>
      </div>
      {onRevoke && !s.current && (
        <IconButton
          icon={LogOut}
          label={`Sign out ${s.device}`}
          size="sm"
          loading={busy}
          onClick={onRevoke}
        />
      )}
    </li>
  );
}

/** Your signed-in devices: see where you're signed in and sign any of them out. */
export function SessionsDialog({ onClose }: { onClose: () => void }) {
  const sessions = useMySessions();
  const revoke = useRevokeSession();
  const { signOutOtherDevices } = useAuth();
  const confirm = useConfirm();
  const toast = useToast();
  const [busyAll, setBusyAll] = useState(false);
  const others = sessions.data?.filter((s) => !s.current) ?? [];

  async function revokeOne(s: SessionDto) {
    try {
      await revoke.mutateAsync(s.id);
      toast({
        title: `${s.device} signed out`,
        description: 'It can’t renew its session; it’s locked out within 15 minutes.',
      });
    } catch (e) {
      toast({ tone: 'danger', title: 'Couldn’t sign it out', description: apiErrorMessage(e) });
    }
  }

  async function revokeOthers() {
    const ok = await confirm({
      title: 'Sign out every other device?',
      description:
        'Every other browser and API client using your account is signed out immediately. This browser stays signed in.',
      confirmLabel: 'Sign them out',
      tone: 'danger',
    });
    if (!ok) return;
    setBusyAll(true);
    try {
      await signOutOtherDevices();
      toast({ title: 'Other devices signed out' });
    } catch (e) {
      toast({ tone: 'danger', title: 'That didn’t work', description: apiErrorMessage(e) });
    } finally {
      setBusyAll(false);
    }
  }

  return (
    <Modal
      title="Signed-in devices"
      description="Where your account is signed in. Sessions renew while in use and end after a period of inactivity."
      onClose={onClose}
      footer={
        others.length > 0 && (
          <Button
            variant="danger-ghost"
            icon={LogOut}
            loading={busyAll}
            onClick={() => void revokeOthers()}
          >
            Sign out all other devices
          </Button>
        )
      }
    >
      {sessions.isLoading ? (
        <LoadingBlock label="Loading sessions…" />
      ) : sessions.isError ? (
        <ErrorState compact error={sessions.error} onRetry={() => void sessions.refetch()} />
      ) : !sessions.data?.length ? (
        <EmptyState compact icon={MonitorSmartphone} title="No active sessions" />
      ) : (
        <ul className="-mx-4 divide-y divide-line-subtle border-y border-line-subtle">
          {sessions.data.map((s) => (
            <SessionRow
              key={s.id}
              s={s}
              busy={revoke.isPending && revoke.variables === s.id}
              onRevoke={() => void revokeOne(s)}
            />
          ))}
        </ul>
      )}
    </Modal>
  );
}
