import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, CircleDollarSign, History, RefreshCw, SquareKanban } from 'lucide-react';
import { HEALTHY_COST_SYNC_OUTCOMES, type CostSyncRunDto, type SyncRunDto } from '@cloudops/core';
import {
  useCancelSync,
  useEnqueueSync,
  useFinopsRuns,
  useSyncCost,
  useSyncRun,
  useSyncRunChanges,
  useSyncRunHistory,
} from '../../lib/queries';
import { usePermissions } from '../../lib/auth';
import { apiErrorMessage } from '../../lib/api';
import { duration, timeAgo } from '../../lib/format';
import {
  Alert,
  Badge,
  Button,
  DescriptionList,
  EmptyState,
  ErrorState,
  LoadingBlock,
  MonoId,
  PageHeader,
  Panel,
  Readout,
  ReadoutGrid,
  RunStatusBadge,
  Select,
  TableSkeleton,
  Tabs,
  TabPanel,
} from '../../components/ui/primitives';
import { Modal } from '../../components/ui/Modal';
import { useConfirm } from '../../components/ui/Dialogs';
import { useToast } from '../../components/ui/Toast';
import { useCreateWork } from '../work/CreateWork';

type Tab = 'inventory' | 'cost';
const STATUSES = ['queued', 'running', 'completed', 'failed'] as const;
/** Inventory older than this is flagged stale — it is only as current as its last sync. */
const STALE_MS = 26 * 3_600_000;

function fmtVal(v: unknown): string {
  if (v == null || v === '') return '—';
  if (typeof v === 'string') return v;
  const s = JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

function scopeLabel(r: SyncRunDto): string {
  if (r.summary) {
    const o = r.summary.orgs.length;
    const s = r.summary.totalSubscriptions;
    return `${o} org${o === 1 ? '' : 's'} · ${s} sub${s === 1 ? '' : 's'}`;
  }
  return r.scope ? `subscription ${r.scope}` : 'all organizations';
}

/**
 * Sync center: every inventory and cost sync — when, who started it, how long
 * it took, what it found, what it couldn't reach and why — with start, cancel
 * (before it starts) and run-again.
 */
export function SyncCenterPage() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'cost' ? 'cost' : 'inventory';
  const runId = params.get('run');
  const { can } = usePermissions();
  const toast = useToast();

  const set = (k: string, v: string | undefined) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: k !== 'run' });
  };

  const recent = useSyncRunHistory({ limit: 20 });
  const cost = useFinopsRuns();
  const enqueue = useEnqueueSync();
  const syncCost = useSyncCost();

  const lastOk = recent.data?.find((r) => r.status === 'completed');
  const lastOkAge = lastOk?.finishedAt ? Date.now() - new Date(lastOk.finishedAt).getTime() : null;
  const failures = recent.data?.filter((r) => r.status === 'failed').length ?? 0;
  const unreachable = lastOk?.summary?.accountErrors ?? [];
  const lastCost = cost.data?.find((r) => r.status === 'completed');
  const costProblems =
    lastCost?.results?.filter((x) => !HEALTHY_COST_SYNC_OUTCOMES.includes(x.outcome)).length ?? 0;

  async function startInventory() {
    try {
      const run = await enqueue.mutateAsync({ providerKey: 'azure' });
      toast({
        title: run.deduplicated ? 'A sync is already in progress' : 'Inventory sync queued',
        description: 'Progress shows below.',
      });
      set('run', run.id);
    } catch (e) {
      toast({ tone: 'danger', title: 'Couldn’t start the sync', description: apiErrorMessage(e) });
    }
  }

  async function startCost() {
    try {
      const r = await syncCost.mutateAsync(undefined);
      toast({
        title: r.deduplicated ? 'A cost sync is already in progress' : 'Cost sync queued',
        description: `Fetching the last ${r.days} days.`,
      });
      set('tab', 'cost');
    } catch (e) {
      toast({
        tone: 'danger',
        title: 'Couldn’t start the cost sync',
        description: apiErrorMessage(e),
      });
    }
  }

  return (
    <div>
      <PageHeader
        overline="Operations"
        title="Sync center"
        subtitle="Every inventory and cost sync: what it found, what it couldn’t reach and why, and how long it took."
        actions={
          <>
            {can('finops.sync') && (
              <Button
                variant="secondary"
                icon={CircleDollarSign}
                loading={syncCost.isPending}
                onClick={() => void startCost()}
              >
                Sync cost
              </Button>
            )}
            {can('inventory.sync') && (
              <Button
                icon={RefreshCw}
                loading={enqueue.isPending}
                onClick={() => void startInventory()}
              >
                Sync inventory
              </Button>
            )}
          </>
        }
      />

      <ReadoutGrid className="mb-6 grid-cols-2 lg:grid-cols-4">
        <Readout
          label="Last inventory sync"
          value={lastOk?.finishedAt ? timeAgo(lastOk.finishedAt) : recent.isLoading ? '…' : 'never'}
          tone={
            lastOkAge === null
              ? recent.isLoading
                ? undefined
                : 'warning'
              : lastOkAge > STALE_MS
                ? 'warning'
                : undefined
          }
          hint={
            lastOkAge !== null && lastOkAge > STALE_MS
              ? 'Stale — inventory may be out of date'
              : lastOk
                ? `took ${duration(lastOk.durationMs)}`
                : 'No completed sync yet'
          }
        />
        <Readout
          label="Failed (last 20)"
          value={recent.data ? failures : '…'}
          tone={failures > 0 ? 'danger' : undefined}
          hint={failures > 0 ? 'Open a run to see why' : 'No recent failures'}
        />
        <Readout
          label="Unreachable orgs"
          value={lastOk ? unreachable.length : '—'}
          tone={unreachable.length > 0 ? 'warning' : undefined}
          hint={
            unreachable.length > 0
              ? unreachable.map((a) => a.account).join(', ')
              : 'On the last completed sync'
          }
          to={unreachable.length > 0 ? '/providers' : undefined}
        />
        <Readout
          label="Last cost sync"
          value={
            lastCost?.finishedAt ? timeAgo(lastCost.finishedAt) : cost.isLoading ? '…' : 'never'
          }
          tone={costProblems > 0 ? 'warning' : undefined}
          hint={
            lastCost
              ? costProblems > 0
                ? `${costProblems} subscription${costProblems === 1 ? '' : 's'} not updated`
                : `${lastCost.records ?? 0} cost records`
              : 'No completed cost sync yet'
          }
        />
      </ReadoutGrid>

      <Tabs
        baseId="sync-center"
        label="Sync type"
        tabs={[
          { id: 'inventory', label: 'Inventory syncs', icon: RefreshCw },
          { id: 'cost', label: 'Cost syncs', icon: CircleDollarSign },
        ]}
        value={tab}
        onChange={(t) => set('tab', t === 'inventory' ? undefined : t)}
        className="mb-4"
      />
      <TabPanel id={tab} baseId="sync-center">
        {tab === 'inventory' ? (
          <InventoryRuns onOpen={(id) => set('run', id)} />
        ) : (
          <CostRuns runs={cost} />
        )}
      </TabPanel>

      {runId && <RunDetail id={runId} onClose={() => set('run', undefined)} />}
    </div>
  );
}

function InventoryRuns({ onOpen }: { onOpen: (id: string) => void }) {
  const [status, setStatus] = useState<(typeof STATUSES)[number] | ''>('');
  const [limit, setLimit] = useState(25);
  const runs = useSyncRunHistory({ limit, ...(status ? { status } : {}) });

  return (
    <Panel
      flush
      title="Inventory syncs"
      description="Discovery of subscriptions, resource groups, resources and relationships. Click a run for its detail."
      actions={
        <Select
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
          aria-label="Status"
          controlSize="sm"
        >
          <option value="">Every status</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s[0]!.toUpperCase() + s.slice(1)}
            </option>
          ))}
        </Select>
      }
      footer={
        runs.data && runs.data.length >= limit && limit < 200 ? (
          <div className="flex justify-center px-4 py-2">
            <Button
              variant="ghost"
              size="sm"
              icon={History}
              onClick={() => setLimit((l) => Math.min(200, l + 25))}
            >
              Show older runs
            </Button>
          </div>
        ) : undefined
      }
    >
      {runs.isLoading ? (
        <TableSkeleton rows={6} cols={6} />
      ) : runs.isError ? (
        <ErrorState compact error={runs.error} onRetry={() => void runs.refetch()} />
      ) : !runs.data?.length ? (
        <EmptyState
          compact
          icon={RefreshCw}
          title={status ? `No ${status} syncs` : 'No syncs yet'}
          description="Start one with “Sync inventory”."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Started</th>
                <th scope="col" className="hidden md:table-cell">
                  Scope
                </th>
                <th scope="col" className="hidden lg:table-cell">
                  By
                </th>
                <th scope="col" className="num hidden sm:table-cell">
                  Duration
                </th>
                <th scope="col" className="num">
                  Found
                </th>
              </tr>
            </thead>
            <tbody>
              {runs.data.map((r) => {
                const problems =
                  (r.summary?.accountErrors?.length ?? 0) + (r.summary?.skipped.length ?? 0);
                return (
                  <tr key={r.id} data-interactive onClick={() => onOpen(r.id)}>
                    <td>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <RunStatusBadge status={r.status} />
                        {r.status === 'completed' && problems > 0 && (
                          <Badge
                            tone="warning"
                            title="Organizations or subscriptions it couldn’t read"
                          >
                            {problems} skipped
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="whitespace-nowrap text-caption">
                      <button
                        type="button"
                        className="link-quiet font-mono"
                        onClick={(e) => (e.stopPropagation(), onOpen(r.id))}
                      >
                        {new Date(r.startedAt ?? r.createdAt).toLocaleString()}
                      </button>
                    </td>
                    <td className="hidden text-caption text-fg-muted md:table-cell">
                      {scopeLabel(r)}
                    </td>
                    <td className="hidden text-caption text-fg-secondary lg:table-cell">
                      {r.triggeredBy ?? (
                        <span
                          className="text-fg-muted"
                          title="Not recorded — runs from before this was tracked"
                        >
                          —
                        </span>
                      )}
                    </td>
                    <td className="num hidden font-mono text-caption sm:table-cell">
                      {duration(r.durationMs)}
                    </td>
                    <td className="num whitespace-nowrap font-mono text-caption">
                      {r.status === 'completed' ? (
                        <>
                          <span title="created">+{r.created}</span>
                          <span className="ml-2 text-fg-muted" title="changes detected">
                            Δ{r.changes}
                          </span>
                          {r.deleted > 0 && (
                            <span className="ml-2 text-warning" title="marked deleted">
                              −{r.deleted}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-fg-muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function RunDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const run = useSyncRun(id);
  const changes = useSyncRunChanges(run.data && run.data.changes > 0 ? id : null);
  const cancel = useCancelSync();
  const enqueue = useEnqueueSync();
  const confirm = useConfirm();
  const toast = useToast();
  const createWork = useCreateWork();
  const { can } = usePermissions();
  const r = run.data;

  async function doCancel() {
    const ok = await confirm({
      title: 'Cancel this sync?',
      description: 'It hasn’t started, so nothing has been read yet.',
      confirmLabel: 'Cancel sync',
      cancelLabel: 'Keep it',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await cancel.mutateAsync(id);
      toast({ title: 'Sync cancelled' });
    } catch (e) {
      toast({ tone: 'danger', title: 'Couldn’t cancel', description: apiErrorMessage(e) });
    }
  }

  async function runAgain() {
    try {
      const next = await enqueue.mutateAsync({
        providerKey: r!.providerKey,
        ...(r!.scope ? { subscriptionId: r!.scope } : {}),
      });
      toast({ title: next.deduplicated ? 'A sync is already in progress' : 'Sync queued' });
    } catch (e) {
      toast({ tone: 'danger', title: 'Couldn’t start the sync', description: apiErrorMessage(e) });
    }
  }

  return (
    <Modal
      size="lg"
      title="Sync run"
      description={r ? `${r.providerKey} · ${scopeLabel(r)}` : undefined}
      onClose={onClose}
      footer={
        r && (
          <div className="flex w-full flex-wrap items-center justify-end gap-2">
            {r.status === 'failed' && can('work.manage') && (
              <Button
                variant="ghost"
                icon={SquareKanban}
                onClick={() =>
                  createWork({
                    defaults: {
                      title: 'Investigate failed inventory sync',
                      type: 'incident',
                      priority: 2,
                      description: r.error ? `The sync failed: ${r.error}` : undefined,
                    },
                    source: {
                      type: 'syncRun',
                      id: r.id,
                      label: `Sync ${new Date(r.createdAt).toLocaleString()}`,
                    },
                  })
                }
              >
                Work item
              </Button>
            )}
            {r.status === 'queued' && can('inventory.sync') && (
              <Button
                variant="danger-ghost"
                loading={cancel.isPending}
                onClick={() => void doCancel()}
              >
                Cancel sync
              </Button>
            )}
            {(r.status === 'failed' || r.status === 'completed') && can('inventory.sync') && (
              <Button
                variant="secondary"
                icon={RefreshCw}
                loading={enqueue.isPending}
                onClick={() => void runAgain()}
              >
                Run again
              </Button>
            )}
          </div>
        )
      }
    >
      {run.isLoading ? (
        <LoadingBlock label="Loading run…" />
      ) : run.isError || !r ? (
        <ErrorState compact error={run.error} onRetry={() => void run.refetch()} />
      ) : (
        <div className="space-y-5">
          <DescriptionList
            items={[
              { label: 'Status', value: <RunStatusBadge status={r.status} /> },
              { label: 'Run', value: <MonoId value={r.id} /> },
              {
                label: 'Started by',
                value: r.triggeredBy ?? 'Not recorded (before this was tracked)',
              },
              { label: 'Queued', value: new Date(r.createdAt).toLocaleString() },
              {
                label: 'Started',
                value: r.startedAt ? new Date(r.startedAt).toLocaleString() : '—',
              },
              {
                label: 'Finished',
                value: r.finishedAt
                  ? `${new Date(r.finishedAt).toLocaleString()} (${duration(r.durationMs)})`
                  : '—',
              },
              {
                label: 'Result',
                value: `${r.created} created · ${r.updated} updated · ${r.changes} changes · ${r.deleted} marked deleted`,
              },
            ]}
          />

          {r.error && (
            <Alert tone="danger" title="Why it failed">
              <span className="break-words font-mono text-caption">{r.error}</span>
            </Alert>
          )}

          {(r.summary?.accountErrors?.length ?? 0) > 0 && (
            <Alert
              tone="warning"
              title="Organizations it couldn’t reach"
              action={
                <Link to="/providers" className="link text-body-sm">
                  Check credentials
                </Link>
              }
            >
              <ul className="space-y-1 text-caption">
                {r.summary!.accountErrors!.map((a) => (
                  <li key={a.account}>
                    <span className="font-medium text-fg">{a.account}</span> — {a.message}
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-caption text-fg-muted">
                Their resources were left as they were — nothing was marked deleted.
              </p>
            </Alert>
          )}

          {r.summary && r.summary.orgs.length > 0 && (
            <section>
              <h3 className="mb-2 text-body-sm font-medium text-fg">By organization</h3>
              <div className="overflow-x-auto rounded-sm border border-line">
                <table className="data-table data-table--compact">
                  <thead>
                    <tr>
                      <th scope="col">Organization</th>
                      <th scope="col" className="num">
                        Subscriptions
                      </th>
                      <th scope="col" className="num">
                        Resources
                      </th>
                      <th scope="col" className="num">
                        Skipped
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.summary.orgs.map((o) => (
                      <tr key={o.organization}>
                        <td>{o.organization}</td>
                        <td className="num font-mono">{o.subscriptions}</td>
                        <td className="num font-mono">{o.resources}</td>
                        <td
                          className={
                            o.skipped.length
                              ? 'num font-mono text-warning'
                              : 'num font-mono text-fg-muted'
                          }
                        >
                          {o.skipped.length}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {(r.summary?.skipped.length ?? 0) > 0 && (
            <details className="rounded-sm border border-line px-3 py-2">
              <summary className="cursor-pointer text-body-sm text-fg-secondary">
                {r.summary!.skipped.length} subscription{r.summary!.skipped.length === 1 ? '' : 's'}{' '}
                skipped
              </summary>
              <ul className="mt-2 space-y-1 text-caption text-fg-muted">
                {r.summary!.skipped.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </details>
          )}

          {(r.summary?.deletionSkipped?.length ?? 0) > 0 && (
            <Alert tone="info" title="Deletion marking held back">
              <ul className="space-y-1 text-caption">
                {r.summary!.deletionSkipped!.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </Alert>
          )}

          {r.changes > 0 && (
            <section>
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="text-body-sm font-medium text-fg">What changed</h3>
                <Link
                  to={`/operations/drift?run=${r.id}`}
                  className="link inline-flex items-center gap-1 text-caption"
                >
                  Open in Drift <ArrowRight className="size-3" aria-hidden />
                </Link>
              </div>
              {changes.isLoading ? (
                <LoadingBlock label="Loading changes…" />
              ) : (
                <ul className="max-h-72 space-y-1.5 overflow-y-auto">
                  {changes.data?.slice(0, 100).map((c) => (
                    <li
                      key={c.id}
                      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption"
                    >
                      <Link to={`/inventory/${c.resourceId}`} className="link-quiet font-medium">
                        {c.resourceName ?? 'resource'}
                      </Link>
                      <Badge mono>{c.field}</Badge>
                      <span className="font-mono text-fg-muted line-through decoration-fg-faint">
                        {fmtVal(c.oldValue)}
                      </span>
                      <ArrowRight className="size-3 text-fg-faint" aria-label="changed to" />
                      <span className="font-mono text-success">{fmtVal(c.newValue)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      )}
    </Modal>
  );
}

function CostRuns({ runs }: { runs: ReturnType<typeof useFinopsRuns> }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Panel
      flush
      title="Cost syncs"
      description="Daily cost pulled from each subscription’s billing data. Subscriptions that weren’t updated say why."
      actions={
        <Link to="/finops?tab=sync" className="link inline-flex items-center gap-1 text-body-sm">
          Cost coverage <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      }
    >
      {runs.isLoading ? (
        <TableSkeleton rows={5} cols={5} />
      ) : runs.isError ? (
        <ErrorState compact error={runs.error} onRetry={() => void runs.refetch()} />
      ) : !runs.data?.length ? (
        <EmptyState
          compact
          icon={CircleDollarSign}
          title="No cost syncs kept"
          description="Cost sync history is kept in the job queue for a while; start one with “Sync cost”."
        />
      ) : (
        <ul className="divide-y divide-line-subtle">
          {runs.data.map((r) => (
            <CostRunRow
              key={r.id}
              run={r}
              open={open === r.id}
              onToggle={() => setOpen(open === r.id ? null : r.id)}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function CostRunRow({
  run: r,
  open,
  onToggle,
}: {
  run: CostSyncRunDto;
  open: boolean;
  onToggle: () => void;
}) {
  const problems = r.results?.filter((x) => !HEALTHY_COST_SYNC_OUTCOMES.includes(x.outcome)) ?? [];
  const started = r.startedAt ?? r.queuedAt;
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left hover:bg-hover md:px-5"
      >
        <RunStatusBadge status={r.status} />
        <span className="min-w-0 text-caption">
          <span className="font-mono text-fg-secondary">
            {started ? new Date(started).toLocaleString() : '—'}
          </span>
          <span className="ml-2 text-fg-muted">
            {r.days ? `last ${r.days} days` : ''}
            {r.retryAttempt > 0 ? ` · automatic retry ${r.retryAttempt}` : ''}
          </span>
        </span>
        <span className="font-mono text-caption">
          {r.records != null && <span>{r.records} records</span>}
          {problems.length > 0 && (
            <span className="ml-2 text-warning">{problems.length} not updated</span>
          )}
        </span>
      </button>
      {open && (
        <div className="animate-fade-in border-t border-line-subtle bg-canvas/60 px-4 py-3 md:px-5">
          {r.error && <p className="mb-2 font-mono text-caption text-danger">{r.error}</p>}
          {r.results?.length ? (
            <table className="data-table data-table--compact">
              <thead>
                <tr>
                  <th scope="col">Subscription</th>
                  <th scope="col">Outcome</th>
                  <th scope="col" className="num">
                    Records
                  </th>
                  <th scope="col" className="hidden md:table-cell">
                    Why
                  </th>
                </tr>
              </thead>
              <tbody>
                {r.results.map((x) => (
                  <tr key={x.subscriptionId}>
                    <td>
                      {x.name}
                      {x.organization && (
                        <div className="text-caption text-fg-muted">{x.organization}</div>
                      )}
                    </td>
                    <td>
                      <Badge
                        tone={
                          HEALTHY_COST_SYNC_OUTCOMES.includes(x.outcome) ? 'success' : 'warning'
                        }
                      >
                        {x.outcome}
                      </Badge>
                    </td>
                    <td className="num font-mono">{x.records}</td>
                    <td className="hidden text-caption text-fg-muted md:table-cell">
                      {x.message ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-caption text-fg-muted">
              {r.status === 'completed'
                ? 'This run predates per-subscription results.'
                : 'Results appear when it finishes.'}
            </p>
          )}
        </div>
      )}
    </li>
  );
}
