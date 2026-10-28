import { Fragment, useState } from 'react';
import { ReactECharts } from '../../lib/echarts';
import { Link } from 'react-router-dom';
import { ArrowRight, ChevronRight, CircleCheck, Radar, RefreshCw, TrendingUp } from 'lucide-react';
import type { CountBucket } from '@cloudops/core';
import {
  useCostAnomalies,
  useDashboardOverview,
  useEnqueueSync,
  useSyncRunChanges,
  useSyncRuns,
} from '../../lib/queries';
import { usePermissions } from '../../lib/auth';
import { useOrg } from '../../lib/orgContext';
import { apiErrorMessage } from '../../lib/api';
import { shortType, money } from '../../lib/format';
import { categoryAxis, chartColors, tooltipStyle, valueAxis } from '../../lib/chartTheme';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  PageHeader,
  Panel,
  Readout,
  ReadoutGrid,
  RunStatusBadge,
  SegmentMeter,
  Skeleton,
  Spinner,
  cn,
  scoreTone,
  severityTone,
} from '../../components/ui/primitives';
import { useToast } from '../../components/ui/Toast';
import { PriorityQueue } from './PriorityQueue';
import { CostOverviewPanel, HealthBreakdown, UrgentWorkPanel } from './panels';

function fmtMoney(amount: number, currency: string): string {
  return money(amount, currency);
}

function barOption(buckets: CountBucket[]) {
  const c = chartColors();
  const data = [...buckets].reverse();
  return {
    grid: { left: 4, right: 24, top: 8, bottom: 4, containLabel: true },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: c.accentFaint } }, ...tooltipStyle(c) },
    xAxis: valueAxis(c),
    yAxis: { ...categoryAxis(c, data.map((b) => shortType(b.label))), axisLabel: { color: c.fgSecondary, fontSize: 11 } },
    series: [
      {
        type: 'bar',
        barMaxWidth: 14,
        data: data.map((b) => b.count),
        itemStyle: { color: c.accent, borderRadius: [0, 2, 2, 0] },
        emphasis: { itemStyle: { color: c.fg } },
      },
    ],
  };
}

function EstateStat({ label, value, to }: { label: string; value: number | string; to: string }) {
  return (
    <Link
      to={to}
      className="group inline-flex items-baseline gap-2 rounded-sm px-3 py-2 transition-colors duration-150 hover:bg-hover"
    >
      <span className="font-mono text-h3 font-medium tabular-nums text-fg">{value}</span>
      <span className="text-caption text-fg-muted group-hover:text-fg-secondary">{label}</span>
    </Link>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-8" role="status" aria-label="Loading command center">
      <div className="overflow-hidden rounded-md border border-line bg-surface">
        <div className="cell-grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="space-y-3 p-5">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-7 w-20" />
              <Skeleton className="h-3 w-32" />
            </div>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="space-y-3 rounded-md border border-line bg-surface p-5">
            <Skeleton className="h-4 w-32" />
            {Array.from({ length: 5 }).map((__, j) => (
              <Skeleton key={j} className="h-3.5" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function DashboardPage() {
  const { tenantId } = useOrg();
  const toast = useToast();
  const { data, isLoading, isError, error, refetch, isRefetching } = useDashboardOverview(tenantId || undefined);
  const enqueue = useEnqueueSync();
  const { can } = usePermissions();
  const canSync = can('inventory.sync');

  const startSync = () =>
    enqueue.mutate(
      { providerKey: 'azure' },
      {
        onSuccess: (run) =>
          run.deduplicated
            ? toast({
                tone: 'info',
                title: 'A sync is already running',
                description: 'Showing its progress under Recent syncs — no second sync was started.',
              })
            : toast({ title: 'Azure sync queued', description: 'Progress shows under Recent syncs on this page.' }),
      },
    );

  const SyncButton = (
    <Button icon={RefreshCw} onClick={startSync} loading={enqueue.isPending}>
      {enqueue.isPending ? 'Queuing…' : 'Sync Azure'}
    </Button>
  );

  const multiOrg = (data?.resourcesByOrganization.length ?? 0) > 1;

  return (
    <div>
      <PageHeader
        overline="Overview"
        title="Command center"
        subtitle="What needs your attention across the estate — health, spend, compliance and work. Served from the local cache."
        actions={canSync ? SyncButton : undefined}
      />

      {enqueue.isError && (
        <Alert tone="danger" title="Couldn’t queue the sync" className="mb-6">
          {apiErrorMessage(enqueue.error)}
        </Alert>
      )}

      {isLoading ? (
        <DashboardSkeleton />
      ) : isError ? (
        <ErrorState title="Couldn’t load the command center" error={error} onRetry={() => void refetch()} retrying={isRefetching} />
      ) : !data ? null : data.kpis.resources === 0 ? (
        <EmptyState
          icon={Radar}
          title="No inventory yet"
          description="Run an Azure sync to discover your organizations, subscriptions, resource groups, and resources."
          action={canSync ? SyncButton : undefined}
        />
      ) : (
        <div className="space-y-8">
          {data.sync.stale && (
            <Alert
              tone="warning"
              title="Inventory may be stale"
              action={
                canSync ? (
                  <Button variant="secondary" size="sm" icon={RefreshCw} onClick={startSync} loading={enqueue.isPending}>
                    Sync now
                  </Button>
                ) : undefined
              }
            >
              Last synced{' '}
              <span className="font-mono text-fg">
                {data.sync.lastSyncAt ? new Date(data.sync.lastSyncAt).toLocaleString() : 'never'}
              </span>
              .
            </Alert>
          )}

          {/* Instrument strip */}
          <div className="space-y-3">
            <ReadoutGrid className="grid-cols-2 xl:grid-cols-4">
              <Readout
                label="Estate health"
                value={data.health.score}
                tone={scoreTone(data.health.score)}
                hint="mean of the signals below"
                visual={<SegmentMeter value={data.health.score} label="Estate health score" />}
              />
              <Readout
                label="Projected monthly cost"
                value={
                  data.cost.hasData
                    ? fmtMoney(data.cost.monthlyProjected + (data.cost.unattributedMonthly ?? 0), data.cost.currency)
                    : '—'
                }
                hint={
                  !data.cost.hasData
                    ? 'Run a FinOps sync'
                    : [
                        data.costInsights.forecast != null ? `forecast ${fmtMoney(data.costInsights.forecast, data.cost.currency)} this month` : null,
                        data.cost.unattributedMonthly > 0
                          ? `incl. ${fmtMoney(data.cost.unattributedMonthly, data.cost.currency)} not matched to a resource`
                          : `${fmtMoney(data.cost.dailyAvg, data.cost.currency)}/day avg`,
                      ]
                        .filter(Boolean)
                        .join(' · ')
                }
                badge={
                  data.costInsights.budgetsOver > 0 ? (
                    <Badge tone="danger">{data.costInsights.budgetsOver} over budget</Badge>
                  ) : data.costInsights.budgetsAtRisk > 0 ? (
                    <Badge tone="warning">{data.costInsights.budgetsAtRisk} at risk</Badge>
                  ) : undefined
                }
                to="/finops"
              />
              <Readout
                label="Compliance"
                value={data.compliance.evaluatedAt ? data.compliance.score : '—'}
                tone={data.compliance.evaluatedAt ? scoreTone(data.compliance.score) : undefined}
                hint={
                  data.compliance.evaluatedAt
                    ? `${data.compliance.failed} failing checks${
                        data.compliance.bySeverity.find((b) => b.severity === 'high')?.failed
                          ? ` · ${data.compliance.bySeverity.find((b) => b.severity === 'high')!.failed} high`
                          : ''
                      }`
                    : 'Run an evaluation'
                }
                visual={
                  data.compliance.evaluatedAt ? (
                    <SegmentMeter value={data.compliance.score} label="Compliance score" />
                  ) : undefined
                }
                to="/standards"
              />
              <Readout
                label="Open work"
                value={data.work.open}
                hint={
                  data.work.overdue > 0 ? (
                    <span className="text-danger">{data.work.overdue} overdue</span>
                  ) : (
                    `${data.work.inProgress} in progress`
                  )
                }
                to="/work"
              />
            </ReadoutGrid>

            <HealthBreakdown components={data.health.components} />

            {/* Estate counts */}
            <nav
              aria-label="Estate totals"
              className="flex flex-wrap items-center gap-x-1 rounded-md border border-line-subtle bg-surface/50 px-1.5 py-1"
            >
              <EstateStat label="Organizations" value={data.kpis.organizations} to="/organizations" />
              <EstateStat label="Subscriptions" value={data.kpis.subscriptions} to="/organizations" />
              <EstateStat label="Resource groups" value={data.kpis.resourceGroups} to="/resource-groups" />
              <EstateStat label="Resources" value={data.kpis.resources} to="/inventory" />
              <EstateStat label="Types" value={data.kpis.distinctTypes} to="/inventory" />
              <EstateStat label="Locations" value={data.kpis.distinctLocations} to="/inventory" />
            </nav>
          </div>

          {/* What to do first */}
          <PriorityQueue items={data.priorities} currency={data.cost.currency} />

          {/* Cost + work */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <CostOverviewPanel insights={data.costInsights} topSpenders={data.cost.topSpenders} currency={data.cost.currency} />
            <UrgentWorkPanel items={data.urgentWork} />
          </div>

          {/* Cost anomalies (spikes above the expected range, new spend) + compliance gaps */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <CostSpikes tenantId={tenantId} />
            <Panel
              title="Top compliance gaps"
              description="Rules with the most failing resources"
              actions={
                <Link to="/standards" className="link inline-flex items-center gap-1 text-body-sm">
                  Standards <ArrowRight className="size-3.5" aria-hidden />
                </Link>
              }
            >
              {!data.compliance.evaluatedAt ? (
                <p className="py-6 text-center text-body-sm text-fg-muted">
                  Not evaluated yet — run an evaluation on the Standards page.
                </p>
              ) : data.compliance.topFailing.length === 0 ? (
                <p className="flex items-center justify-center gap-2 py-6 text-body-sm text-success">
                  <CircleCheck className="size-4" aria-hidden /> All checks passing.
                </p>
              ) : (
                <ul className="divide-y divide-line-subtle">
                  {data.compliance.topFailing.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                      <Link to={`/standards?rule=${r.id}`} className="link-quiet min-w-0 truncate text-body-sm">
                        {r.name}
                        <span className="ml-2 text-caption text-fg-muted">{r.standardName}</span>
                      </Link>
                      <span className="flex shrink-0 items-center gap-3">
                        <Badge tone={severityTone(r.severity)}>{r.severity}</Badge>
                        <span className="w-8 text-right font-mono text-body-sm tabular-nums text-danger" title="Failing resources">
                          {r.failed}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          {/* Distribution. The overview API returns by-organization and by-type buckets. */}
          <div className={cn('grid grid-cols-1 gap-4', multiOrg && 'lg:grid-cols-2')}>
            {multiOrg && (
              <Panel title="Resources by organization">
                <ReactECharts option={barOption(data.resourcesByOrganization)} style={{ height: 280 }} />
              </Panel>
            )}
            <Panel title="Resources by type">
              <ReactECharts option={barOption(data.resourcesByType)} style={{ height: 280 }} />
            </Panel>
          </div>

          {/* Recent activity: drift + syncs */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel title="Recent configuration drift" description="Field changes detected on the last syncs">
              {data.drift.length === 0 ? (
                <p className="py-6 text-center text-body-sm text-fg-muted">No changes detected on the last syncs.</p>
              ) : (
                <ul className="divide-y divide-line-subtle">
                  {data.drift.map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                      <span className="flex min-w-0 items-center gap-2 text-body-sm">
                        {d.resourceId ? (
                          <Link to={`/inventory/${d.resourceId}`} className="link-quiet truncate">
                            {d.resourceName ?? 'resource'}
                          </Link>
                        ) : (
                          <span className="truncate text-fg-secondary">{d.resourceName ?? 'resource'}</span>
                        )}
                        <Badge mono className="shrink-0">
                          {d.field}
                        </Badge>
                      </span>
                      <span className="shrink-0 font-mono text-caption tabular-nums text-fg-muted">
                        {new Date(d.detectedAt).toLocaleDateString()}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <RecentSyncsCard />
          </div>
        </div>
      )}
    </div>
  );
}

/** Compact render of a change-event value (string / tag object / scalar). */
function fmtChangeVal(v: unknown): string {
  if (v == null || v === '') return '—';
  if (typeof v === 'string') return v;
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

/**
 * Recent syncs with an inline "what changed" drilldown: rows that detected
 * changes are clickable and expand to the field-level diffs for that run.
 */
function RecentSyncsCard() {
  const runs = useSyncRuns();
  const [openId, setOpenId] = useState<string | null>(null);
  const changes = useSyncRunChanges(openId);

  return (
    <Panel
      title="Recent syncs"
      description="Expand a run to see what changed"
      flush
    >
      {runs.isLoading ? (
        <div className="p-5">
          <Spinner label="Loading syncs…" />
        </div>
      ) : runs.data && runs.data.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="data-table data-table--compact">
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col" className="hidden sm:table-cell">
                  Scope
                </th>
                <th scope="col">Changes</th>
                <th scope="col" className="num">
                  Finished
                </th>
              </tr>
            </thead>
            <tbody>
              {runs.data.slice(0, 6).map((r) => {
                const open = openId === r.id;
                const canExpand = r.changes > 0;
                const panelId = `sync-changes-${r.id}`;
                return (
                  <Fragment key={r.id}>
                    <tr
                      data-interactive={canExpand || undefined}
                      data-expanded={open || undefined}
                      onClick={() => canExpand && setOpenId(open ? null : r.id)}
                    >
                      <td>
                        <RunStatusBadge status={r.status} />
                      </td>
                      <td className="hidden whitespace-nowrap text-fg-muted sm:table-cell">
                        {r.summary
                          ? `${r.summary.orgs.length} org${r.summary.orgs.length === 1 ? '' : 's'} · ${r.summary.totalSubscriptions} sub${r.summary.totalSubscriptions === 1 ? '' : 's'}`
                          : '—'}
                      </td>
                      <td>
                        {canExpand ? (
                          <button
                            type="button"
                            aria-expanded={open}
                            aria-controls={panelId}
                            onClick={(e) => {
                              e.stopPropagation();
                              setOpenId(open ? null : r.id);
                            }}
                            className="inline-flex items-center gap-1 rounded-xs font-mono tabular-nums text-accent hover:text-accent-hover"
                          >
                            <ChevronRight
                              className={cn('size-3.5 transition-transform duration-150', open && 'rotate-90')}
                              aria-hidden
                            />
                            {r.changes}
                            <span className="sr-only"> changes — {open ? 'hide' : 'show'} details</span>
                          </button>
                        ) : (
                          <span className="pl-[18px] font-mono tabular-nums text-fg-faint">0</span>
                        )}
                      </td>
                      <td className="num whitespace-nowrap text-fg-muted">
                        {r.finishedAt ? new Date(r.finishedAt).toLocaleTimeString() : '—'}
                      </td>
                    </tr>
                    {open && (
                      <tr id={panelId}>
                        <td colSpan={4} className="!bg-canvas/60 !py-3">
                          {changes.isLoading ? (
                            <Spinner label="Loading changes…" />
                          ) : !changes.data || changes.data.length === 0 ? (
                            <p className="text-caption text-fg-muted">No field-level changes recorded for this run.</p>
                          ) : (
                            <ul className="animate-fade-in space-y-1.5">
                              {changes.data.map((c) => (
                                <li key={c.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption">
                                  {c.resourceId ? (
                                    <Link to={`/inventory/${c.resourceId}`} className="link-quiet font-medium">
                                      {c.resourceName ?? 'resource'}
                                    </Link>
                                  ) : (
                                    <span className="font-medium text-fg-secondary">{c.resourceName ?? 'resource'}</span>
                                  )}
                                  <Badge mono>{c.field}</Badge>
                                  <span className="font-mono text-fg-muted line-through decoration-fg-faint">
                                    {fmtChangeVal(c.oldValue)}
                                  </span>
                                  <ArrowRight className="size-3 text-fg-faint" aria-label="changed to" />
                                  <span className="font-mono text-success">{fmtChangeVal(c.newValue)}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="px-5 py-8 text-center text-body-sm text-fg-muted">No syncs recorded yet.</p>
      )}
    </Panel>
  );
}

const ANOMALY_KIND_LABEL = { spike: 'spike', 'new-resource': 'new spend', 'new-region': 'new region' } as const;

/**
 * Cost anomaly monitor: resources whose latest day is above the range their
 * history predicts, and spend that just appeared — each with its monthly
 * impact and the reason it was flagged. Renders nothing until there is cost data.
 */
function CostSpikes({ tenantId }: { tenantId: string }) {
  const anomalies = useCostAnomalies(tenantId || undefined);
  const data = anomalies.data;
  if (!data || !data.latestDate) return null; // no cost data yet — the FinOps insight covers that

  const maxBandCount = Math.max(1, ...data.bands.map((b) => b.count));
  const spikes = data.byKind.find((k) => k.kind === 'spike')?.count ?? 0;

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <TrendingUp className="size-4 text-danger" aria-hidden />
          Cost spikes
        </span>
      }
      description={`${new Date(data.latestDate).toLocaleDateString()} vs the ${data.baselineDays} days before · ignores changes under ${fmtMoney(data.minDailyDelta, data.currency)}/day · Cost Management data lags 1–2 days`}
      actions={
        <Link to="/finops?tab=anomalies" className="link inline-flex items-center gap-1 text-body-sm">
          All anomalies <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      }
    >
      {data.flagged === 0 ? (
        <p className="flex items-center gap-2 text-body-sm text-success">
          <CircleCheck className="size-4" aria-hidden />
          Nothing outside its expected range on the latest day.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-6">
          {/* Distribution across hike bands */}
          <div>
            <div className="mb-3 font-mono text-overline uppercase text-fg-muted">
              {data.flagged} flagged · {fmtMoney(data.totalMonthlyImpact, data.currency)}/mo if they persist
            </div>
            {spikes === 0 && <p className="text-body-sm text-fg-muted">No spikes — only new spend.</p>}
            <ul className="space-y-2">
              {data.bands.map((b) => (
                <li key={b.band} className="flex items-center gap-3 text-body-sm">
                  <span className="w-12 shrink-0 text-right font-mono text-caption tabular-nums text-fg-muted">
                    {b.band >= 100 ? '100%+' : `≥${b.band}%`}
                  </span>
                  <div className="h-3 flex-1 overflow-hidden rounded-xs bg-raised">
                    <div
                      className={cn('h-full rounded-xs', b.band >= 50 ? 'bg-danger/80' : 'bg-warning/80')}
                      style={{ width: `${Math.max(4, (b.count / maxBandCount) * 100)}%` }}
                    />
                  </div>
                  <span className="w-8 shrink-0 font-mono tabular-nums text-fg">{b.count}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Biggest movers */}
          <div>
            <div className="mb-3 font-mono text-overline uppercase text-fg-muted">Biggest impact</div>
            <ul className="divide-y divide-line-subtle">
              {data.anomalies.slice(0, 6).map((a) => (
                <li key={a.externalId} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0" title={a.reason}>
                  <span className="min-w-0 truncate text-body-sm">
                    {a.resourceId ? (
                      <Link to={`/inventory/${a.resourceId}`} className="link-quiet">
                        {a.name}
                      </Link>
                    ) : (
                      <span className="text-fg-secondary">{a.name}</span>
                    )}
                    {a.type && <span className="ml-2 text-caption text-fg-muted">{shortType(a.type)}</span>}
                  </span>
                  <span className="flex shrink-0 items-center gap-3">
                    <span className="hidden font-mono text-caption tabular-nums text-fg-muted sm:inline">
                      {a.kind === 'spike' ? `${fmtMoney(a.baseline, data.currency)} → ` : ''}
                      {fmtMoney(a.latest, data.currency)}/day
                    </span>
                    <Badge tone={a.kind !== 'spike' || a.band >= 50 ? 'danger' : 'warning'} mono>
                      {a.deltaPct != null ? `↑ ${a.deltaPct}%` : ANOMALY_KIND_LABEL[a.kind]}
                    </Badge>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Panel>
  );
}
