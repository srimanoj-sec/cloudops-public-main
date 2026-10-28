import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  HEALTHY_COST_SYNC_OUTCOMES,
  type CostCoverageDto,
  type CostSyncOutcome,
  type CostSyncRunDto,
  type CostSyncSubscriptionResultDto,
} from '@cloudops/core';
import { useCostCoverage, useFinopsRuns } from '../../lib/queries';
import { Alert, Badge, Button, Panel, RunStatusBadge, cn, type Tone } from '../../components/ui/primitives';

/** What each per-subscription outcome means, and what (if anything) to do about it. */
export const OUTCOME: Record<CostSyncOutcome, { label: string; tone: Tone; help: string }> = {
  updated: { label: 'Updated', tone: 'success', help: 'Cost for the window was refreshed.' },
  'no-data': {
    label: 'No cost in window',
    tone: 'neutral',
    help: 'Azure returned no cost for the window, which is normal for a subscription with nothing billable. Existing data is kept.',
  },
  disabled: {
    label: 'Disabled',
    tone: 'neutral',
    help: 'Disabled or deleted in Azure, so it isn’t queried. Its existing cost data is kept.',
  },
  throttled: { label: 'Throttled', tone: 'warning', help: 'Azure rate-limited the query. It is retried automatically after 5 minutes.' },
  network: { label: 'Network error', tone: 'warning', help: 'The query couldn’t reach Azure. It is retried automatically after 5 minutes.' },
  'no-access': { label: 'No access', tone: 'danger', help: 'The organization’s credentials can’t read this subscription’s cost.' },
  unsupported: { label: 'Not supported', tone: 'warning', help: 'Azure Cost Management doesn’t cover this subscription’s offer type.' },
  unconverted: { label: 'No exchange rate', tone: 'danger', help: 'Billed in another currency with no exchange rate available.' },
  error: { label: 'Failed', tone: 'danger', help: 'The cost query failed. See the reason.' },
};

const healthy = (o: CostSyncOutcome) => HEALTHY_COST_SYNC_OUTCOMES.includes(o);

/** A subscription whose cost data isn't current, and not because it's disabled. */
export function needsAttention(c: CostCoverageDto): boolean {
  if (c.last) return !healthy(c.last.outcome) || (c.lastCostDate == null && c.last.outcome !== 'disabled');
  return c.lastCostDate == null && c.state?.toLowerCase() !== 'disabled';
}

/** Time today, date + time otherwise. */
export function whenLabel(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString()
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function daysBehind(date: string): number {
  return Math.floor((Date.now() - new Date(`${date}T00:00:00Z`).getTime()) / 86_400_000);
}

function OutcomeBadge({ outcome }: { outcome: CostSyncOutcome }) {
  const o = OUTCOME[outcome] ?? OUTCOME.error;
  return (
    <Badge tone={o.tone} dot title={o.help}>
      {o.label}
    </Badge>
  );
}

function LastResult({ c }: { c: CostCoverageDto }) {
  if (!c.last) return <span className="text-caption text-fg-muted">Not in a recorded sync yet</span>;
  return (
    <>
      <OutcomeBadge outcome={c.last.outcome} />
      {c.last.outcome !== 'updated' && (
        <div className="mt-1 text-caption text-fg-muted">{c.last.message ?? OUTCOME[c.last.outcome].help}</div>
      )}
    </>
  );
}

function Coverage({ rows }: { rows: CostCoverageDto[] }) {
  const attention = rows.filter(needsAttention);
  return (
    <>
      {attention.length > 0 && (
        <Alert
          tone="warning"
          className="m-3"
          title={`${attention.length} subscription${attention.length === 1 ? ' isn’t' : 's aren’t'} getting cost data`}
        >
          Their existing cost is kept, but new cost won’t appear until the reason below is resolved. Totals for their
          organizations are understated until then.
        </Alert>
      )}
      <div className="overflow-x-auto">
        <table className="data-table data-table--compact">
          <thead>
            <tr>
              <th scope="col">Subscription</th>
              <th scope="col">
                <span className="sm:hidden">Through</span>
                <span className="hidden sm:inline">Cost data through</span>
              </th>
              <th scope="col" className="hidden sm:table-cell">
                Last sync result
              </th>
              <th scope="col" className="num hidden lg:table-cell">
                When
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const behind = c.lastCostDate ? daysBehind(c.lastCostDate) : null;
              return (
                <tr key={c.id} className={cn(needsAttention(c) && 'bg-warning/5')}>
                  <td className="max-w-[18rem]">
                    <div className="truncate font-medium text-fg">{c.name}</div>
                    <div className="truncate text-caption text-fg-muted">
                      {c.organization ?? 'No organization'}
                      {c.state && c.state !== 'Enabled' ? ` · ${c.state}` : ''}
                    </div>
                    <div className="mt-1.5 whitespace-normal sm:hidden">
                      <LastResult c={c} />
                    </div>
                  </td>
                  <td>
                    {c.lastCostDate ? (
                      <>
                        <span className="font-mono text-caption tabular-nums text-fg">
                          {new Date(`${c.lastCostDate}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC' })}
                        </span>
                        {behind != null && behind > 2 && (
                          <div className="text-caption text-fg-muted">{behind} days ago</div>
                        )}
                      </>
                    ) : (
                      <span className="text-caption font-medium text-danger">Never</span>
                    )}
                  </td>
                  <td className="hidden max-w-[28rem] sm:table-cell">
                    <LastResult c={c} />
                  </td>
                  <td className="num hidden text-fg-muted lg:table-cell">{whenLabel(c.last?.at ?? null)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** "5 of 7 updated", from the outcomes, or from the legacy counts for older runs. */
function updatedLabel(r: CostSyncRunDto): string {
  if (r.subscriptions == null) return '—';
  const updated = r.results ? r.results.filter((x) => x.outcome === 'updated').length : r.subscriptions - (r.skipped ?? 0);
  return `${updated} of ${r.subscriptions}`;
}

function IssueSummary({ r }: { r: CostSyncRunDto }) {
  if (r.status !== 'completed') return <span className="text-fg-faint">—</span>;
  if (!r.results) {
    return r.skipped ? (
      <span className="text-caption text-fg-muted" title="This run finished before per-subscription results were recorded.">
        {r.skipped} not updated (reason not recorded)
      </span>
    ) : (
      <span className="text-caption text-fg-muted">None</span>
    );
  }
  const counts = new Map<CostSyncOutcome, number>();
  for (const x of r.results) if (x.outcome !== 'updated') counts.set(x.outcome, (counts.get(x.outcome) ?? 0) + 1);
  if (counts.size === 0) return <span className="text-caption text-success">All updated</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {[...counts].map(([o, n]) => (
        <Badge key={o} tone={OUTCOME[o].tone} title={OUTCOME[o].help}>
          {OUTCOME[o].label} · {n}
        </Badge>
      ))}
    </span>
  );
}

function RunResults({ results }: { results: CostSyncSubscriptionResultDto[] }) {
  return (
    <ul className="divide-y divide-line-subtle">
      {results.map((x) => (
        <li key={x.subscriptionId} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-2 py-2">
          <span className="min-w-[14rem] flex-1">
            <span className="font-medium text-fg">{x.name}</span>
            {x.organization && <span className="text-caption text-fg-muted"> · {x.organization}</span>}
            {x.message && <span className="mt-0.5 block text-caption text-fg-muted">{x.message}</span>}
          </span>
          <span className="flex items-center gap-3">
            {x.outcome === 'updated' && (
              <span className="font-mono text-caption tabular-nums text-fg-muted">{x.records} records</span>
            )}
            <OutcomeBadge outcome={x.outcome} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function Runs({ runs }: { runs: CostSyncRunDto[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <div className="overflow-x-auto">
      <table className="data-table data-table--compact">
        <thead>
          <tr>
            <th scope="col">Status</th>
            <th scope="col">Window</th>
            <th scope="col" className="num">
              Records
            </th>
            <th scope="col" className="num hidden sm:table-cell">
              Subscriptions updated
            </th>
            <th scope="col" className="hidden md:table-cell">
              Not updated
            </th>
            <th scope="col" className="num">
              When
            </th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const open = expanded === r.id;
            const canExpand = Boolean(r.results?.length);
            return (
              <Fragment key={r.id}>
                <tr>
                  <td>
                    <span className="flex items-center gap-1.5">
                      {canExpand ? (
                        <button
                          type="button"
                          onClick={() => setExpanded(open ? null : r.id)}
                          aria-expanded={open}
                          aria-label={open ? 'Hide per-subscription results' : 'Show per-subscription results'}
                          className="grid size-5 place-items-center rounded-xs text-fg-muted hover:bg-hover hover:text-fg"
                        >
                          {open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
                        </button>
                      ) : (
                        <span className="size-5" aria-hidden />
                      )}
                      <RunStatusBadge status={r.status} />
                    </span>
                  </td>
                  <td className="font-mono text-caption">
                    {r.days != null ? `${r.days}d` : '—'}
                    {r.retryAttempt > 0 && <span className="ml-1.5 font-sans text-fg-muted">retry {r.retryAttempt}</span>}
                  </td>
                  <td className="num text-fg">{r.records != null ? r.records : r.status === 'running' ? '…' : '—'}</td>
                  <td className="num hidden sm:table-cell">{updatedLabel(r)}</td>
                  <td className="hidden md:table-cell">
                    <IssueSummary r={r} />
                  </td>
                  <td className="num text-fg-muted">{whenLabel(r.finishedAt ?? r.startedAt ?? r.queuedAt)}</td>
                </tr>
                {open && r.results && (
                  <tr>
                    <td colSpan={6} className="bg-canvas/60">
                      <RunResults results={r.results} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Cost sync status: per-subscription coverage (how current each subscription's
 * cost is, and why not) above the recent runs. Updates live while a run is going.
 */
export function CostSyncPanel({ tenantId }: { tenantId?: string }) {
  const runs = useFinopsRuns();
  const coverage = useCostCoverage();
  const [open, setOpen] = useState(true);
  const rows = (coverage.data ?? []).filter((c) => !tenantId || c.organizationId === tenantId);
  const recent = (runs.data ?? []).slice(0, 6);
  if (rows.length === 0 && recent.length === 0) return null;
  const last = recent[0];
  return (
    <Panel
      className="mt-6"
      flush
      title="Cost sync"
      description="How current each subscription’s cost data is, and the recent sync runs. Updates live."
      actions={
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          icon={ChevronDown}
          className={cn('[&>svg]:transition-transform [&>svg]:duration-150', !open && '[&>svg]:-rotate-90')}
        >
          {open ? 'Hide' : 'Show'}
        </Button>
      }
    >
      {open && (
        <>
          {last?.status === 'failed' && last.error && (
            <Alert tone="danger" title="Last sync failed" className="m-3">
              {last.error}
            </Alert>
          )}
          {rows.length > 0 && <Coverage rows={rows} />}
          {recent.length > 0 && (
            <>
              <h3 className="border-t border-line-subtle px-4 pb-1 pt-4 text-overline uppercase tracking-wider text-fg-muted md:px-5">
                Recent runs
              </h3>
              <Runs runs={recent} />
            </>
          )}
        </>
      )}
    </Panel>
  );
}
