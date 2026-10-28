import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { KeyRound, Pencil, Plus, UserCheck, UserX, Users } from 'lucide-react';
import { ROLES, ROLE_DEFINITIONS, type AdminUserDto, type Role } from '@cloudops/core';
import { useCreateUser, useResetUserPassword, useUpdateUser, useUsers } from '../../lib/queries';
import { useAuth } from '../../lib/auth';
import { apiErrorMessage } from '../../lib/api';
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  InlineError,
  Input,
  PageHeader,
  Panel,
  TableSkeleton,
} from '../../components/ui/primitives';
import { Modal } from '../../components/ui/Modal';
import { useConfirm } from '../../components/ui/Dialogs';
import { useToast } from '../../components/ui/Toast';
import { AdminGate } from './AdminGate';
import { PermissionMatrix, UserDetailDialog } from './UserAccess';

function RolePicker({ value, onChange }: { value: Role[]; onChange: (roles: Role[]) => void }) {
  return (
    <fieldset className="space-y-1">
      <legend className="mb-1.5 text-label text-fg-secondary">Roles</legend>
      {ROLES.map((r) => (
        <Checkbox
          key={r}
          checked={value.includes(r)}
          onChange={() =>
            onChange(value.includes(r) ? value.filter((x) => x !== r) : [...value, r])
          }
          className="items-start"
        >
          <span className="font-medium text-fg">{ROLE_DEFINITIONS[r].label}</span>
          <span className="ml-2 text-caption text-fg-muted">{ROLE_DEFINITIONS[r].description}</span>
        </Checkbox>
      ))}
    </fieldset>
  );
}

function CreateUserDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateUser();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [roles, setRoles] = useState<Role[]>(['viewer']);

  async function submit() {
    await create.mutateAsync({ email, name, password, roles });
    toast({ title: 'User created', description: `${name} can now sign in as ${email}.` });
    onClose();
  }

  return (
    <Modal
      title="Add user"
      description="Share the initial password with them securely; they can change it from their account menu."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit().catch(() => undefined)}
            disabled={!email || !name || password.length < 10 || roles.length === 0}
            loading={create.isPending}
          >
            Create user
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Email" required>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="off"
            />
          </Field>
        </div>
        <Field label="Initial password" hint="At least 10 characters." required>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </Field>
        <RolePicker value={roles} onChange={setRoles} />
        {create.isError && <InlineError>{apiErrorMessage(create.error)}</InlineError>}
      </div>
    </Modal>
  );
}

function EditUserDialog({ user, onClose }: { user: AdminUserDto; onClose: () => void }) {
  const update = useUpdateUser();
  const toast = useToast();
  const [name, setName] = useState(user.name);
  const [roles, setRoles] = useState<Role[]>(user.roles as Role[]);

  async function submit() {
    await update.mutateAsync({ id: user.id, input: { name, roles } });
    toast({ title: 'User updated', description: user.email });
    onClose();
  }

  return (
    <Modal
      title={`Edit ${user.name || user.email}`}
      description={user.email}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit().catch(() => undefined)}
            disabled={!name || roles.length === 0}
            loading={update.isPending}
          >
            Save changes
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <RolePicker value={roles} onChange={setRoles} />
        <p className="text-caption text-fg-muted">
          Role changes apply within 30 seconds, without the user signing out.
        </p>
        {update.isError && <InlineError>{apiErrorMessage(update.error)}</InlineError>}
      </div>
    </Modal>
  );
}

function ResetPasswordDialog({ user, onClose }: { user: AdminUserDto; onClose: () => void }) {
  const reset = useResetUserPassword();
  const toast = useToast();
  const [password, setPassword] = useState('');

  async function submit() {
    await reset.mutateAsync({ id: user.id, password });
    toast({
      title: 'Password reset',
      description: `${user.email} has been signed out everywhere.`,
    });
    onClose();
  }

  return (
    <Modal
      size="sm"
      title="Reset password"
      description={`Sets a new password for ${user.email} and signs them out of every session.`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit().catch(() => undefined)}
            disabled={password.length < 10}
            loading={reset.isPending}
          >
            Reset password
          </Button>
        </>
      }
    >
      <Field label="New password" hint="At least 10 characters." required>
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
        />
      </Field>
      {reset.isError && <InlineError className="mt-3">{apiErrorMessage(reset.error)}</InlineError>}
    </Modal>
  );
}

function UsersTable() {
  const { user: me } = useAuth();
  const users = useUsers();
  const update = useUpdateUser();
  const confirm = useConfirm();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [dialog, setDialogState] = useState<
    | { kind: 'create' }
    | { kind: 'edit'; user: AdminUserDto }
    | { kind: 'reset'; user: AdminUserDto }
    | null
  >(() => (params.get('add') === '1' ? { kind: 'create' } : null));
  // Deep links: ?add=1 opens "Add user"; ?user=<id> opens that user's access.
  const detailId = params.get('user');
  const detail = users.data?.find((u) => u.id === detailId) ?? null;
  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const setDialog = (d: typeof dialog) => {
    setDialogState(d);
    if (!d && params.has('add')) setParam('add', null);
  };

  async function toggleActive(u: AdminUserDto) {
    if (u.isActive) {
      const ok = await confirm({
        title: `Deactivate ${u.name || u.email}?`,
        description:
          'They are signed out immediately and cannot sign in until reactivated. Their history is kept.',
        confirmLabel: 'Deactivate',
        tone: 'danger',
      });
      if (!ok) return;
    }
    try {
      await update.mutateAsync({ id: u.id, input: { isActive: !u.isActive } });
      toast({ title: u.isActive ? 'User deactivated' : 'User reactivated', description: u.email });
    } catch (err) {
      toast({ tone: 'danger', title: 'Could not update user', description: apiErrorMessage(err) });
    }
  }

  return (
    <>
      <PageHeader
        overline="Platform"
        title="Users"
        subtitle="Who can sign in, and what they can do. Admins manage accounts; every change is recorded in the audit log."
        actions={
          <Button icon={Plus} onClick={() => setDialog({ kind: 'create' })}>
            Add user
          </Button>
        }
      />
      <Panel
        flush
        title={
          <span className="flex items-center gap-2">
            Accounts{' '}
            {users.data && (
              <span className="font-mono font-normal text-fg-muted">{users.data.length}</span>
            )}
          </span>
        }
      >
        {users.isLoading ? (
          <TableSkeleton rows={4} cols={5} />
        ) : users.isError ? (
          <ErrorState compact error={users.error} onRetry={() => void users.refetch()} />
        ) : !users.data?.length ? (
          <EmptyState compact icon={Users} title="No users" />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">User</th>
                  <th scope="col">Roles</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="hidden md:table-cell">
                    Last sign-in
                  </th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.data.map((u) => {
                  const isMe = u.id === me?.id;
                  return (
                    <tr key={u.id} data-interactive onClick={() => setParam('user', u.id)}>
                      <td>
                        <div className="font-medium text-fg">
                          <button
                            type="button"
                            className="link-quiet"
                            onClick={(e) => (e.stopPropagation(), setParam('user', u.id))}
                          >
                            {u.name || '—'}
                          </button>{' '}
                          {isMe && <Badge className="ml-1">you</Badge>}
                        </div>
                        <div className="text-caption text-fg-muted">{u.email}</div>
                      </td>
                      <td>
                        <div className="flex flex-wrap gap-1">
                          {u.roles.map((r) => (
                            <Badge key={r} tone={r === 'admin' ? 'accent' : 'neutral'}>
                              {r}
                            </Badge>
                          ))}
                        </div>
                      </td>
                      <td>
                        <Badge tone={u.isActive ? 'success' : 'neutral'} dot>
                          {u.isActive ? 'active' : 'deactivated'}
                        </Badge>
                      </td>
                      <td className="hidden font-mono text-caption md:table-cell">
                        {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'never'}
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <span className="flex items-center justify-end gap-1">
                          <IconButton
                            icon={Pencil}
                            label="Edit user"
                            size="sm"
                            onClick={() => setDialog({ kind: 'edit', user: u })}
                          />
                          <IconButton
                            icon={KeyRound}
                            label="Reset password"
                            size="sm"
                            onClick={() => setDialog({ kind: 'reset', user: u })}
                          />
                          <IconButton
                            icon={u.isActive ? UserX : UserCheck}
                            label={
                              isMe
                                ? 'You cannot deactivate yourself'
                                : u.isActive
                                  ? 'Deactivate'
                                  : 'Reactivate'
                            }
                            size="sm"
                            variant={u.isActive ? 'danger-ghost' : 'ghost'}
                            disabled={isMe}
                            onClick={() => void toggleActive(u)}
                          />
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="mt-6">
        <PermissionMatrix />
      </div>

      {detail && (
        <UserDetailDialog
          user={detail}
          isMe={detail.id === me?.id}
          onClose={() => setParam('user', null)}
          onEdit={() => {
            setParam('user', null);
            setDialog({ kind: 'edit', user: detail });
          }}
        />
      )}
      {dialog?.kind === 'create' && <CreateUserDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === 'edit' && (
        <EditUserDialog user={dialog.user} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'reset' && (
        <ResetPasswordDialog user={dialog.user} onClose={() => setDialog(null)} />
      )}
    </>
  );
}

export function UsersPage() {
  return (
    <AdminGate permission="users.manage">
      <UsersTable />
    </AdminGate>
  );
}
