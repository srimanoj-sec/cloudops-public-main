import { Link } from 'react-router-dom';
import { Check, History, LogOut, MonitorSmartphone } from 'lucide-react';
import {
  PERMISSIONS,
  PERMISSION_GROUPS,
  ROLES,
  ROLE_DEFINITIONS,
  permissionsFor,
  type AdminUserDto,
  type Role,
} from '@cloudops/core';
import { useSignOutUser, useUserSessions } from '../../lib/queries';
import { apiErrorMessage } from '../../lib/api';
import {
  Badge,
  Button,
  DescriptionList,
  EmptyState,
  ErrorState,
  LoadingBlock,
  Panel,
} from '../../components/ui/primitives';
import { Modal } from '../../components/ui/Modal';
import { useConfirm } from '../../components/ui/Dialogs';
import { useToast } from '../../components/ui/Toast';
import { SessionRow } from '../account/SessionsDialog';

/** Roles × permissions: exactly what each role may do (the API enforces the same catalog). */
export function PermissionMatrix() {
  const granted = Object.fromEntries(ROLES.map((r) => [r, new Set(permissionsFor([r]))])) as Record<
    Role,
    Set<string>
  >;
  return (
    <Panel
      flush
      title="What each role can do"
      description="Everyone can read everything in the estate; roles add the actions below. A user with several roles gets all of their permissions."
    >
      <div className="overflow-x-auto">
        <table className="data-table data-table--compact">
          <thead>
            <tr>
              <th scope="col">Permission</th>
              {ROLES.map((r) => (
                <th key={r} scope="col" className="text-center">
                  {ROLE_DEFINITIONS[r].label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PERMISSION_GROUPS.map((g) => [
              <tr key={g.label}>
                <td
                  colSpan={ROLES.length + 1}
                  className="!bg-raised/40 font-mono text-overline uppercase text-fg-muted"
                >
                  {g.label}
                </td>
              </tr>,
              ...g.permissions.map((p) => (
                <tr key={p}>
                  <td>
                    <span className="font-mono text-caption text-fg">{p}</span>
                    <div className="text-caption text-fg-muted">{PERMISSIONS[p]}</div>
                  </td>
                  {ROLES.map((r) => (
                    <td key={r} className="text-center">
                      {granted[r].has(p) ? (
                        <Check className="mx-auto size-4 text-success" aria-label="granted" />
                      ) : (
                        <span className="text-fg-faint" aria-label="not granted">
                          ·
                        </span>
                      )}
                    </td>
                  ))}
                </tr>
              )),
            ])}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/** One user's access at a glance: roles, effective permissions, signed-in devices, sign out everywhere. */
export function UserDetailDialog({
  user,
  isMe,
  onClose,
  onEdit,
}: {
  user: AdminUserDto;
  isMe: boolean;
  onClose: () => void;
  onEdit: () => void;
}) {
  const sessions = useUserSessions(user.id);
  const signOut = useSignOutUser();
  const confirm = useConfirm();
  const toast = useToast();
  const perms = new Set(permissionsFor(user.roles));

  async function signOutEverywhere() {
    const ok = await confirm({
      title: `Sign ${user.name || user.email} out everywhere?`,
      description: isMe
        ? 'That includes this browser — you’ll need to sign in again.'
        : 'Every browser and API client using this account is signed out immediately. They can sign in again with their password.',
      confirmLabel: 'Sign out everywhere',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await signOut.mutateAsync(user.id);
      toast({ title: 'Signed out everywhere', description: user.email });
    } catch (e) {
      toast({ tone: 'danger', title: 'That didn’t work', description: apiErrorMessage(e) });
    }
  }

  return (
    <Modal
      size="lg"
      title={user.name || user.email}
      description={user.email}
      onClose={onClose}
      footer={
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          <Link
            to={`/settings/audit?actorId=${user.id}`}
            className="link mr-auto inline-flex items-center gap-1 text-body-sm"
          >
            <History className="size-3.5" aria-hidden /> Their activity
          </Link>
          <Button
            variant="danger-ghost"
            icon={LogOut}
            loading={signOut.isPending}
            onClick={() => void signOutEverywhere()}
          >
            Sign out everywhere
          </Button>
          <Button variant="secondary" onClick={onEdit}>
            Edit roles
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        <DescriptionList
          items={[
            {
              label: 'Status',
              value: (
                <Badge tone={user.isActive ? 'success' : 'neutral'} dot>
                  {user.isActive ? 'active' : 'deactivated'}
                </Badge>
              ),
            },
            {
              label: 'Roles',
              value: (
                <span className="flex flex-wrap gap-1">
                  {user.roles.map((r) => (
                    <Badge
                      key={r}
                      tone={r === 'admin' ? 'accent' : 'neutral'}
                      title={ROLE_DEFINITIONS[r as Role]?.description}
                    >
                      {ROLE_DEFINITIONS[r as Role]?.label ?? r}
                    </Badge>
                  ))}
                </span>
              ),
            },
            {
              label: 'Last sign-in',
              value: user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : 'never',
            },
          ]}
        />

        <section>
          <h3 className="mb-2 text-body-sm font-medium text-fg">Can do</h3>
          {perms.size === 0 ? (
            <p className="text-caption text-fg-muted">
              Read-only: sees everything, changes nothing.
            </p>
          ) : (
            <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              {PERMISSION_GROUPS.filter((g) => g.permissions.some((p) => perms.has(p))).map((g) => (
                <div key={g.label}>
                  <div className="mb-1 font-mono text-overline uppercase text-fg-muted">
                    {g.label}
                  </div>
                  <ul className="space-y-0.5 text-caption text-fg-secondary">
                    {g.permissions
                      .filter((p) => perms.has(p))
                      .map((p) => (
                        <li key={p} className="flex items-start gap-1.5">
                          <Check className="mt-0.5 size-3 shrink-0 text-success" aria-hidden />
                          {PERMISSIONS[p]}
                        </li>
                      ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <h3 className="mb-2 text-body-sm font-medium text-fg">Signed-in devices</h3>
          {sessions.isLoading ? (
            <LoadingBlock label="Loading sessions…" />
          ) : sessions.isError ? (
            <ErrorState compact error={sessions.error} onRetry={() => void sessions.refetch()} />
          ) : !sessions.data?.length ? (
            <EmptyState compact icon={MonitorSmartphone} title="Not signed in anywhere" />
          ) : (
            <ul className="divide-y divide-line-subtle rounded-sm border border-line">
              {sessions.data.map((s) => (
                <SessionRow key={s.id} s={s} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  );
}
