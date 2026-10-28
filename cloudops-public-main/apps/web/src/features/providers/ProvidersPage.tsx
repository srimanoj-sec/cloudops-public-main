import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Check,
  Cloud,
  KeyRound,
  Pause,
  Pencil,
  Play,
  Plug,
  PlugZap,
  Plus,
  Trash2,
} from 'lucide-react';
import {
  PROVIDER_CAPABILITIES,
  PROVIDER_CAPABILITY_INFO,
  type AccountConnResult,
  type ProviderAccountDto,
} from '@cloudops/core';
import {
  useCreateProviderAccount,
  useDeleteProviderAccount,
  useProviderAccounts,
  useProviderAccountsStatus,
  useProviders,
  useTestProviderAccount,
  useTestProviderCredentials,
  useUpdateProviderAccount,
} from '../../lib/queries';
import { usePermissions } from '../../lib/auth';
import { apiErrorMessage } from '../../lib/api';
import { Modal } from '../../components/ui/Modal';
import { useConfirm } from '../../components/ui/Dialogs';
import { useToast } from '../../components/ui/Toast';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  InlineError,
  Input,
  LoadingBlock,
  MonoId,
  PageHeader,
  Panel,
  SectionHeading,
  Skeleton,
  Textarea,
} from '../../components/ui/primitives';

/** Blank form state for the add/edit dialog. */
const EMPTY_FORM = { name: '', tenantId: '', clientId: '', clientSecret: '' };
type AccountForm = typeof EMPTY_FORM;

function ConnResultLine({ result }: { result: AccountConnResult }) {
  return (
    <Alert tone={result.ok ? 'success' : 'danger'} className="animate-fade-in">
      {result.message}
    </Alert>
  );
}

/**
 * Add / edit one organization. The client secret is write-only: editing an
 * existing org shows an empty secret field, and leaving it empty keeps the
 * stored one.
 */
function AccountDialog({
  providerKey,
  account,
  onClose,
}: {
  providerKey: string;
  account: ProviderAccountDto | null;
  onClose: () => void;
}) {
  const editing = account !== null;
  const isGcp = providerKey === 'gcp';
  const toast = useToast();
  const [form, setForm] = useState<AccountForm>(
    account
      ? {
          name: account.name,
          tenantId: account.tenantId,
          clientId: account.clientId,
          clientSecret: '',
        }
      : EMPTY_FORM,
  );
  const create = useCreateProviderAccount(providerKey);
  const update = useUpdateProviderAccount(providerKey);
  const test = useTestProviderCredentials(providerKey);

  const set =
    (key: keyof AccountForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  const complete = form.name && form.tenantId && form.clientId;
  // A test always needs a secret; an edit that keeps the stored one cannot be
  // tested from the form — use the row's Test button instead.
  const canTest = Boolean(complete && form.clientSecret);
  const canSave = Boolean(complete && (editing || form.clientSecret));
  const busy = create.isPending || update.isPending;
  const error = create.error ?? update.error ?? test.error;

  async function save() {
    try {
      if (editing) {
        await update.mutateAsync({
          id: account.id,
          input: {
            name: form.name,
            tenantId: form.tenantId,
            clientId: form.clientId,
            ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}),
          },
        });
      } else {
        await create.mutateAsync({ ...form, enabled: true });
      }
      toast({
        title: isGcp
          ? editing
            ? 'Project updated'
            : 'Project added'
          : editing
            ? 'Organization updated'
            : 'Organization added',
        description: form.name,
      });
      onClose();
    } catch {
      // Surfaced below via the mutation's error state.
    }
  }

  return (
    <Modal
      title={
        editing ? `Edit ${account.name}` : isGcp ? 'Add Google Cloud project' : 'Add organization'
      }
      description={
        isGcp
          ? 'One Google Cloud project authenticated by a service account.'
          : 'One service principal per Entra tenant.'
      }
      onClose={onClose}
      footer={
        <>
          <Button
            variant="secondary"
            icon={PlugZap}
            className="sm:mr-auto"
            onClick={() => test.mutate({ ...form, enabled: true })}
            disabled={!canTest}
            loading={test.isPending}
            title={
              canTest
                ? undefined
                : `Enter ${isGcp ? 'a service account key' : 'a client secret'} to test these credentials`
            }
          >
            {test.isPending ? 'Testing…' : 'Test credentials'}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={!canSave} loading={busy}>
            {busy
              ? 'Saving…'
              : editing
                ? 'Save changes'
                : isGcp
                  ? 'Add project'
                  : 'Add organization'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label="Display name"
          hint="How this organization appears across the platform."
          required
        >
          <Input value={form.name} onChange={set('name')} placeholder="Contoso Production" />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={isGcp ? 'Google Cloud project ID' : 'Directory (tenant) ID'} required>
            <Input
              className="font-mono"
              value={form.tenantId}
              onChange={set('tenantId')}
              placeholder={isGcp ? 'my-cloud-project' : '00000000-0000-0000-0000-000000000000'}
            />
          </Field>
          <Field
            label={isGcp ? 'Service account email' : 'Application (client) ID'}
            hint={
              isGcp
                ? 'The client_email value from the service account JSON key.'
                : 'The service principal’s app ID.'
            }
            required
          >
            <Input
              className="font-mono"
              value={form.clientId}
              onChange={set('clientId')}
              placeholder={
                isGcp
                  ? 'cloudops-reader@my-cloud-project.iam.gserviceaccount.com'
                  : '00000000-0000-0000-0000-000000000000'
              }
            />
          </Field>
        </div>
        <Field
          label={isGcp ? 'Service account JSON key' : 'Client secret'}
          required={!editing}
          hint={
            editing
              ? isGcp
                ? 'Leave empty to keep the stored key. Enter the full JSON key file to rotate it.'
                : 'Leave empty to keep the stored secret. Enter a new value to rotate it.'
              : isGcp
                ? 'Paste the full downloaded JSON key file. It is encrypted on this machine and never shown again.'
                : 'Stored encrypted on this machine — never in the database, never shown again.'
          }
        >
          {isGcp ? (
            <Textarea
              className="min-h-32 font-mono text-caption"
              value={form.clientSecret}
              onChange={set('clientSecret')}
              maxLength={16384}
              autoComplete="new-password"
              placeholder={editing ? '(unchanged)' : '{ "type": "service_account", ... }'}
            />
          ) : (
            <Input
              type="password"
              icon={KeyRound}
              value={form.clientSecret}
              onChange={set('clientSecret')}
              autoComplete="new-password"
              placeholder={editing ? '•••••••• (unchanged)' : ''}
            />
          )}
        </Field>

        <p className="rounded-sm border border-line-subtle bg-canvas/50 px-3 py-2.5 text-caption text-fg-muted">
          {isGcp ? (
            <>
              Grant the service account{' '}
              <span className="font-medium text-fg-secondary">Cloud Asset Viewer</span> and{' '}
              <span className="font-medium text-fg-secondary">Browser</span> on the project for
              inventory. Cloud insights additionally need Security Center Findings Viewer,
              Monitoring Viewer, IAM Security Reviewer, Service Health Viewer and Recommender
              Viewer. VM start/stop also needs a custom role granting only
              compute.instances.start and compute.instances.stop.
            </>
          ) : (
            <>
              The service principal needs{' '}
              <span className="font-medium text-fg-secondary">Reader</span> on each subscription you
              want synced, plus{' '}
              <span className="font-medium text-fg-secondary">Tag Contributor</span> if you use tag
              write-back.
            </>
          )}
        </p>

        {test.data && <ConnResultLine result={test.data} />}
        {error && <InlineError>{apiErrorMessage(error)}</InlineError>}
      </div>
    </Modal>
  );
}

/** One organization row (responsive: grid on desktop, stacked on phones). */
function AccountRow({
  providerKey,
  account,
  canManage,
  onEdit,
}: {
  providerKey: string;
  account: ProviderAccountDto;
  canManage: boolean;
  onEdit: () => void;
}) {
  const test = useTestProviderAccount(providerKey);
  const update = useUpdateProviderAccount(providerKey);
  const remove = useDeleteProviderAccount(providerKey);
  const confirm = useConfirm();
  const toast = useToast();
  const fromEnv = account.source === 'env';
  const isGcp = providerKey === 'gcp';

  return (
    <li className="px-4 py-3 md:px-5">
      <div className="grid grid-cols-1 items-center gap-3 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)_21.5rem] lg:gap-4">
        <div className="min-w-0">
          <div className="truncate text-body-sm font-medium text-fg">{account.name}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {fromEnv ? (
              <Badge tone="warning" mono>
                .env
              </Badge>
            ) : (
              <Badge tone={account.enabled ? 'success' : 'neutral'} dot>
                {account.enabled ? 'active' : 'paused'}
              </Badge>
            )}
            {!account.secretSet && (
              <Badge tone="danger" dot>
                no secret
              </Badge>
            )}
          </div>
        </div>
        <div className="min-w-0">
          <div className="text-caption text-fg-muted lg:hidden">
            {isGcp ? 'Project ID' : 'Directory (tenant) ID'}
          </div>
          <MonoId value={account.tenantId} truncate />
        </div>
        <div className="min-w-0">
          <div className="text-caption text-fg-muted lg:hidden">
            {isGcp ? 'Service account email' : 'Application (client) ID'}
          </div>
          <MonoId value={account.clientId} truncate />
        </div>
        <div className="flex flex-wrap items-center gap-1 lg:justify-end">
          <Button
            variant="ghost"
            size="sm"
            icon={PlugZap}
            onClick={() => test.mutate(account.id)}
            disabled={!canManage}
            loading={test.isPending}
          >
            {test.isPending ? 'Testing…' : 'Test'}
          </Button>
          {!fromEnv && (
            <>
              <Button
                variant="ghost"
                size="sm"
                icon={account.enabled ? Pause : Play}
                onClick={() =>
                  update.mutate({ id: account.id, input: { enabled: !account.enabled } })
                }
                disabled={!canManage}
                loading={update.isPending}
              >
                {account.enabled ? 'Pause' : 'Resume'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={Pencil}
                onClick={onEdit}
                disabled={!canManage}
              >
                Edit
              </Button>
              <Button
                variant="danger-ghost"
                size="sm"
                icon={Trash2}
                disabled={!canManage}
                loading={remove.isPending}
                onClick={async () => {
                  const ok = await confirm({
                    title: 'Remove organization?',
                    description: `“${account.name}” and its stored secret will be removed.`,
                    confirmLabel: 'Remove',
                    tone: 'danger',
                  });
                  if (ok)
                    remove.mutate(account.id, {
                      onSuccess: () =>
                        toast({ title: 'Organization removed', description: account.name }),
                    });
                }}
              >
                Remove
              </Button>
            </>
          )}
        </div>
      </div>
      {(test.data || test.isError || remove.isError || update.isError) && (
        <div className="mt-3 space-y-2">
          {test.data && <ConnResultLine result={test.data} />}
          {(test.error || remove.error || update.error) && (
            <InlineError>{apiErrorMessage(test.error ?? remove.error ?? update.error)}</InlineError>
          )}
        </div>
      )}
    </li>
  );
}

/** The organizations a provider syncs — the credentials live here, not in .env. */
function ProviderAccountsCard({
  providerKey,
  displayName,
  canManage,
  autoAdd,
}: {
  providerKey: string;
  displayName: string;
  canManage: boolean;
  /** Open "Add organization" straight away (deep link `?add=1`). */
  autoAdd?: boolean;
}) {
  const isGcp = providerKey === 'gcp';
  const accounts = useProviderAccounts(providerKey);
  const status = useProviderAccountsStatus(providerKey);
  const [, setParams] = useSearchParams();
  const [dialog, setDialogState] = useState<{ account: ProviderAccountDto | null } | null>(() =>
    autoAdd && canManage ? { account: null } : null,
  );
  const setDialog = (d: typeof dialog) => {
    setDialogState(d);
    if (!d && autoAdd) setParams({}, { replace: true });
  };

  const rows = accounts.data ?? [];

  return (
    <Panel
      className="mt-8"
      flush
      title={`${displayName} ${isGcp ? 'projects' : 'organizations'}`}
      description={
        isGcp
          ? 'One project per service account. JSON keys are encrypted on this machine — never stored in the database.'
          : 'One service principal per Entra tenant. Secrets are encrypted on this machine — never stored in the database.'
      }
      actions={
        <Button
          icon={Plus}
          onClick={() => setDialog({ account: null })}
          disabled={!canManage}
          title={canManage ? undefined : 'Administrators only'}
        >
          {isGcp ? 'Add project' : 'Add organization'}
        </Button>
      }
    >
      {(status.data?.envCount || !canManage) && (
        <div className="space-y-2 border-b border-line-subtle p-3">
          {status.data?.envCount ? (
            <Alert tone="warning">
              {status.data.envCount} organization(s) still come from{' '}
              <span className="font-mono text-fg">AZURE_ORGS</span> in your .env. They are shown
              read-only. To manage them here, add them above and delete the variable — an org
              configured in both places uses the copy stored here.
            </Alert>
          ) : null}
          {!canManage && (
            <Alert tone="info">Sign in as an administrator to change cloud credentials.</Alert>
          )}
        </div>
      )}

      {accounts.isLoading ? (
        <LoadingBlock label="Loading organizations…" className="min-h-[8rem]" />
      ) : accounts.isError ? (
        <ErrorState
          compact
          error={accounts.error}
          onRetry={() => void accounts.refetch()}
          retrying={accounts.isRefetching}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          compact
          icon={KeyRound}
          title={isGcp ? 'No projects configured' : 'No organizations configured'}
          description={
            <>
              {isGcp ? (
                <>Add a service account key to sync a Google Cloud project.</>
              ) : (
                <>
                  Sync currently falls back to whatever{' '}
                  <span className="font-mono text-fg-secondary">az login</span> session the API host
                  has. Add a service principal to sync a tenant on its own credentials.
                </>
              )}
            </>
          }
        />
      ) : (
        <>
          <div className="hidden grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)_21.5rem] gap-4 border-b border-line bg-raised/60 px-5 py-2 font-mono text-overline uppercase text-fg-muted lg:grid">
            <span>Organization</span>
            <span>{isGcp ? 'Project ID' : 'Directory (tenant) ID'}</span>
            <span>{isGcp ? 'Service account email' : 'Application (client) ID'}</span>
            <span className="sr-only">Actions</span>
          </div>
          <ul className="divide-y divide-line-subtle">
            {rows.map((a) => (
              <AccountRow
                key={a.id}
                providerKey={providerKey}
                account={a}
                canManage={canManage}
                onEdit={() => setDialog({ account: a })}
              />
            ))}
          </ul>
        </>
      )}

      {dialog && (
        <AccountDialog
          providerKey={providerKey}
          account={dialog.account}
          onClose={() => setDialog(null)}
        />
      )}
    </Panel>
  );
}

export function ProvidersPage() {
  const { data, isLoading, isError, error, refetch, isRefetching } = useProviders();
  const { can } = usePermissions();
  const canManage = can('provider.manage');
  const [searchParams] = useSearchParams();

  return (
    <div>
      <PageHeader
        overline="Platform"
        title="Providers"
        subtitle="Registered provider plugins, supported capabilities, and the cloud organizations or projects each one syncs."
      />
      {isLoading ? (
        <div
          className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
          role="status"
          aria-label="Loading providers"
        >
          <Skeleton className="h-36 rounded-md" />
          <Skeleton className="h-36 rounded-md" />
        </div>
      ) : isError ? (
        <ErrorState
          title="Couldn’t load providers"
          error={error}
          onRetry={() => void refetch()}
          retrying={isRefetching}
        />
      ) : !data ? null : (
        <>
          <SectionHeading title="Plugins" count={data.length} />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {data.map((p) => (
              <Panel key={p.key}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-sm border border-line bg-raised">
                      <Cloud className="size-[18px] text-accent" aria-hidden />
                    </span>
                    <div className="min-w-0">
                      <div className="truncate text-h4 text-fg">{p.displayName}</div>
                      <div className="font-mono text-caption text-fg-muted">
                        {p.key} · {p.accountCount}{' '}
                        {p.key === 'gcp'
                          ? 'project' + (p.accountCount === 1 ? '' : 's')
                          : 'organization' + (p.accountCount === 1 ? '' : 's')}
                      </div>
                    </div>
                  </div>
                  <Badge tone={p.registered ? 'success' : 'neutral'} dot>
                    {p.registered ? 'registered' : 'available'}
                  </Badge>
                </div>
                <ul
                  className="mt-4 grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2"
                  aria-label="Capabilities"
                >
                  {PROVIDER_CAPABILITIES.map((c) => {
                    const has = (p.capabilities as readonly string[]).includes(c);
                    return (
                      <li
                        key={c}
                        className={
                          has
                            ? 'flex items-start gap-1.5 text-caption text-fg-secondary'
                            : 'flex items-start gap-1.5 text-caption text-fg-faint'
                        }
                        title={PROVIDER_CAPABILITY_INFO[c].description}
                      >
                        {has ? (
                          <Check
                            className="mt-0.5 size-3 shrink-0 text-success"
                            aria-label="supported"
                          />
                        ) : (
                          <span className="w-3 shrink-0 text-center" aria-label="not supported">
                            ·
                          </span>
                        )}
                        {PROVIDER_CAPABILITY_INFO[c].label}
                      </li>
                    );
                  })}
                </ul>
              </Panel>
            ))}
            <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-line px-6 py-8 text-center">
              <span className="grid size-9 place-items-center rounded-sm border border-dashed border-line-strong text-fg-muted">
                <Plug className="size-[18px]" aria-hidden />
              </span>
              <div className="mt-3 text-body-sm text-fg-secondary">
                AWS · Kubernetes · Terraform · GitHub · …
              </div>
              <div className="mt-1 text-caption text-fg-muted">
                Implement the <span className="font-mono">CloudProvider</span> interface to add one
              </div>
            </div>
          </div>

          {data.map((p, i) => (
            <ProviderAccountsCard
              key={p.key}
              providerKey={p.key}
              displayName={p.displayName}
              canManage={canManage}
              autoAdd={i === 0 && searchParams.get('add') === '1'}
            />
          ))}
        </>
      )}
    </div>
  );
}
