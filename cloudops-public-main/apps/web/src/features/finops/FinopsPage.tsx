import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { money as compactMoney, moneyFull } from '../../lib/format';
import { ReactECharts } from '../../lib/echarts';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowRight,
  Building2,
  CalendarRange,
  CircleDollarSign,
  Download,
  FolderTree,
  KeyRound,
  RefreshCw,
} from 'lucide-react';
import { BudgetsPanel, MonthStrip, SavingsPanel, UnattributedPanel } from './FinopsInsights';
import { CostSyncPanel, needsAttention, whenLabel } from './CostSyncPanel';
import { AnomaliesPanel } from './AnomaliesPanel';

/** Page sections deep links can land on (`/finops?tab=anomalies`). */
const SECTIONS = [
  { id: 'explorer', label: 'Explorer' },
  { id: 'anomalies', label: 'Anomalies' },
  { id: 'budgets', label: 'Budgets' },
  { id: 'savings', label: 'Savings' },
  { id: 'unattributed', label: 'Unattributed' },
  { id: 'sync', label: 'Sync history' },
] as const;

function jumpTo(id: string, smooth = true) {
  document
    .getElementById(`finops-${id}`)
    ?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
}
import type {
  FinopsBreakdownRow,
  FinopsGranularity,
  FinopsGroupBy,
  FinopsPreset,
  FinopsQueryResult,
  FinopsSeriesPoint,
} from '@cloudops/core';
import {
  useFacets,
  useFinopsOverview,
  useFinopsQuery,
  useCostCoverage,
  useFinopsRuns,
  useOrganizations,
  useResourceGroups,
  useSubscriptions,
  useSyncCost,
} from '../../lib/queries';
import { usePermissions } from '../../lib/auth';
import { useOrg } from '../../lib/orgContext';
import { apiErrorMessage } from '../../lib/api';
import {
  MONO,
  categoryAxis,
  chartColors,
  tooltipStyle,
  trendSeries,
  valueAxis,
} from '../../lib/chartTheme';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Input,
  Meter,
  PageHeader,
  Panel,
  Readout,
  ReadoutGrid,
  RunStatusBadge,
  SegmentedControl,
  Select,
  Skeleton,
  Spinner,
  TextButton,
  cn,
} from '../../components/ui/primitives';
import { useToast } from '../../components/ui/Toast';

const PRESETS: { key: FinopsPreset; label: string }[] = [
  { key: '1d', label: '1D' },
  { key: '7d', label: '7D' },
  { key: '30d', label: '30D' },
  { key: '90d', label: '90D' },
  { key: 'custom', label: 'Custom' },
];
const GROUP_BY: { key: FinopsGroupBy; label: string; kind: 'scope' | 'attribute' }[] = [
  { key: 'organization', label: 'Organization', kind: 'scope' },
  { key: 'subscription', label: 'Subscription', kind: 'scope' },
  { key: 'resourceGroup', label: 'Resource group', kind: 'scope' },
  { key: 'resource', label: 'Resource', kind: 'scope' },
  { key: 'service', label: 'Service (type)', kind: 'attribute' },
  { key: 'category', label: 'Category', kind: 'attribute' },
  { key: 'owner', label: 'Owner', kind: 'attribute' },
  { key: 'tag', label: 'Tag…', kind: 'attribute' },
];
const GRANULARITIES: FinopsGranularity[] = ['day', 'week', 'month'];
const NEXT_LEVEL: Record<FinopsGroupBy, FinopsGroupBy | null> = {
  organization: 'subscription',
  subscription: 'resourceGroup',
  resourceGroup: 'resource',
  resource: null,
  service: null,
  category: null,
  owner: null,
  tag: null,
};
const GROUP_LABEL: Record<FinopsGroupBy, string> = {
  organization: 'organization',
  subscription: 'subscription',
  resourceGroup: 'resource group',
  resource: 'resource',
  service: 'service',
  category: 'category',
  owner: 'owner',
  tag: 'tag',
};

/** Inventory link for an attribute breakdown row (service/category/owner/tag). */
function inventoryHref(r: FinopsBreakdownRow, tagKey: string): string | null {
  if (r.key.startsWith('__not_in_inventory')) return null;
  switch (r.scopeType) {
    case 'service':
      return r.key === 'other' ? null : `/inventory?q=${encodeURIComponent(r.key)}`;
    case 'category':
      return `/inventory?categories=${encodeURIComponent(r.key)}`;
    case 'owner':
      return `/inventory?owners=${encodeURIComponent(r.key === '__unassigned__' ? '__unassigned__' : r.key)}`;
    case 'tag':
      return r.key === '__untagged__' || !tagKey
        ? null
        : `/inventory?tags=${encodeURIComponent(`${tagKey}:${r.key}`)}`;
    default:
      return null;
  }
}

/** Download the current breakdown as CSV (client-side — it's already loaded). */
function exportBreakdown(data: FinopsQueryResult, showCompare: boolean) {
  const esc = (v: unknown) => {
    const t = String(v ?? '');
    const safe = /^[=+\-@\t\r]/.test(t) ? `'${t}` : t;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const head = [
    'name',
    'cost',
    ...(showCompare ? ['previous_cost', 'change_pct'] : []),
    'currency',
  ];
  const lines = data.breakdown.map((r) =>
    [
      r.label,
      r.cost,
      ...(showCompare ? [r.previousCost ?? '', r.deltaPct ?? ''] : []),
      data.currency,
    ]
      .map(esc)
      .join(','),
  );
  const blob = new Blob([`\ufeff${[head.join(','), ...lines].join('\r\n')}`], {
    type: 'text/csv;charset=utf-8',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `cloudops-cost-by-${data.groupBy}-${data.range.from.slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function money(n: number, currency: string): string {
  return moneyFull(n, currency);
}
function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
/** Inclusive range label (range.to is exclusive → show to − 1 day). */
function fmtRange(from: string, to: string): string {
  const start = new Date(from);
  const end = new Date(new Date(to).getTime() - 86400000);
  const s = start.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const e = end.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  return `${s} – ${e}`;
}

/** Savings-framed delta (down = green = saved). */
function DeltaBadge({ pct }: { pct: number | null | undefined }) {
  if (pct == null) return <span className="font-mono text-caption text-fg-faint">—</span>;
  const down = pct < 0;
  return (
    <Badge tone={down ? 'success' : pct > 0 ? 'danger' : 'neutral'} mono>
      {down ? '↓' : pct > 0 ? '↑' : ''} {Math.abs(pct).toFixed(1)}%
    </Badge>
  );
}

/** One labelled row of the query builder. */
function ControlRow({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-2 md:flex-row md:items-center md:gap-4', className)}>
      <span className="w-32 shrink-0 font-mono text-overline uppercase text-fg-muted">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

/** Latest cost-sync status, shown under the page title — plus a flag when a subscription's cost isn't current. */
function LatestCostSync() {
  const runs = useFinopsRuns();
  const coverage = useCostCoverage();
  const last = runs.data?.[0];
  if (!last) return null;
  const stale = (coverage.data ?? []).filter(needsAttention).length;
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-caption text-fg-muted">
      Last cost sync <RunStatusBadge status={last.status} />
      <span className="font-mono tabular-nums">
        {whenLabel(last.finishedAt ?? last.startedAt ?? last.queuedAt)}
      </span>
      {stale > 0 && (
        <Badge tone="warning" dot title="See Cost sync at the bottom of the page">
          {stale} subscription{stale === 1 ? '' : 's'} without current cost
        </Badge>
      )}
    </span>
  );
}

export function FinopsPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = usePermissions();
  const canSync = can('finops.sync');
  const sync = useSyncCost();
  const [searchParams] = useSearchParams();
  const section = searchParams.get('tab');
  const landed = useRef<string | null>(null);

  const [preset, setPreset] = useState<FinopsPreset>('30d');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [granularity, setGranularity] = useState<FinopsGranularity | ''>('');
  const [groupBy, setGroupBy] = useState<FinopsGroupBy>('subscription');
  const [tagKey, setTagKey] = useState('');
  const facets = useFacets();
  // Organization scope is global (header switcher); sub/RG stay local to this page.
  const { tenantId, setTenantId } = useOrg();
  const [subscriptionId, setSubscriptionId] = useState('');
  const [resourceGroupId, setResourceGroupId] = useState('');
  // Reset the sub/RG cascade whenever the org changes (incl. from the header).
  useEffect(() => {
    setSubscriptionId('');
    setResourceGroupId('');
  }, [tenantId]);
  const [compareMode, setCompareMode] = useState<'off' | 'previous' | 'custom'>('previous');
  const [compareFrom, setCompareFrom] = useState('');
  const [compareTo, setCompareTo] = useState('');
  const compare = compareMode !== 'off';

  const orgs = useOrganizations();
  const subs = useSubscriptions();
  const rgs = useResourceGroups(subscriptionId || undefined);
  const orgSubs = useMemo(
    () => (tenantId ? (subs.data ?? []).filter((s) => s.tenantId === tenantId) : (subs.data ?? [])),
    [subs.data, tenantId],
  );

  const params = useMemo(
    () => ({
      preset,
      ...(preset === 'custom' && from && to ? { from, to } : {}),
      ...(granularity ? { granularity } : {}),
      groupBy,
      ...(groupBy === 'tag' && tagKey ? { tagKey } : {}),
      ...(tenantId ? { tenantId } : {}),
      ...(subscriptionId ? { subscriptionId } : {}),
      ...(resourceGroupId ? { resourceGroupId } : {}),
      compare,
      ...(compareMode === 'custom' && compareFrom && compareTo ? { compareFrom, compareTo } : {}),
    }),
    [
      preset,
      from,
      to,
      granularity,
      groupBy,
      tagKey,
      tenantId,
      subscriptionId,
      resourceGroupId,
      compareMode,
      compareFrom,
      compareTo,
      compare,
    ],
  );
  const { data, isLoading, isFetching, isError, error, refetch, isRefetching } =
    useFinopsQuery(params);
  const overview = useFinopsOverview({
    ...(tenantId ? { tenantId } : {}),
    ...(subscriptionId ? { subscriptionId } : {}),
  });
  const currency = data?.currency ?? '';
  const showCompare = Boolean(data?.previousRange && data?.previousComplete);

  // Land on the linked section once everything above it has rendered, so it doesn't get pushed down.
  const settled = Boolean(overview.data) && !isLoading;
  useEffect(() => {
    if (!section || landed.current === section || !SECTIONS.some((s) => s.id === section)) return;
    if (!settled && section !== 'explorer') return;
    landed.current = section;
    requestAnimationFrame(() => jumpTo(section, false));
  }, [section, settled]);

  function startSync() {
    sync.mutate(undefined, {
      onSuccess: (res) =>
        res?.deduplicated
          ? toast({
              tone: 'info',
              title: 'A cost sync is already in progress',
              description: 'No second sync was started — track it in Cost sync history below.',
            })
          : toast({
              title: 'Cost sync queued',
              description: `${res?.days ?? ''}-day window. Track its status in Cost sync history below.`,
            }),
    });
  }

  function drill(r: FinopsBreakdownRow) {
    const href = inventoryHref(r, tagKey);
    if (href) {
      navigate(href);
      return;
    }
    if (r.scopeType === 'resource') {
      if (r.scopeId) navigate(`/inventory/${r.scopeId}`);
      return;
    }
    if (!r.scopeId) return;
    if (r.scopeType === 'organization') {
      setTenantId(r.scopeId);
      setSubscriptionId('');
      setResourceGroupId('');
    } else if (r.scopeType === 'subscription') {
      setSubscriptionId(r.scopeId);
      setResourceGroupId('');
    } else if (r.scopeType === 'resourceGroup') {
      setResourceGroupId(r.scopeId);
    }
    const next = NEXT_LEVEL[r.scopeType];
    if (next) setGroupBy(next);
  }

  const scopeActive = tenantId || subscriptionId || resourceGroupId;

  return (
    <div>
      <PageHeader
        overline="Cost & governance"
        title="FinOps"
        subtitle="Break cost down by organization, subscription, resource group, or resource — over any period — and compare against a baseline to track savings."
        meta={<LatestCostSync />}
        actions={
          canSync && (
            <Button icon={RefreshCw} onClick={startSync} loading={sync.isPending}>
              {sync.isPending ? 'Queuing…' : 'Sync costs'}
            </Button>
          )
        }
      />

      {sync.isError && (
        <Alert tone="danger" title="Couldn’t queue the cost sync" className="mb-6">
          {apiErrorMessage(sync.error)}
        </Alert>
      )}

      {overview.data?.latestDate && (
        <div className="mb-6">
          <MonthStrip o={overview.data} />
        </div>
      )}

      <nav
        aria-label="FinOps sections"
        className="mb-4 flex flex-wrap gap-x-4 gap-y-1 text-body-sm"
      >
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => jumpTo(s.id)}
            className="text-fg-muted transition-colors duration-150 hover:text-accent"
          >
            {s.label}
          </button>
        ))}
      </nav>

      {/* ── Query builder ── */}
      <div id="finops-explorer" className="scroll-mt-4" />
      <Panel className="mb-6" bodyClassName="divide-y divide-line-subtle p-0">
        <ControlRow label="Period" className="px-4 py-3 md:px-5">
          <SegmentedControl
            label="Period"
            options={PRESETS.map((p) => ({ value: p.key, label: p.label }))}
            value={preset}
            onChange={setPreset}
          />
          {preset === 'custom' && (
            <span className="flex items-center gap-2">
              <Input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                aria-label="Start date"
                className="w-40"
              />
              <ArrowRight className="size-4 text-fg-faint" aria-hidden />
              <Input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                aria-label="End date"
                className="w-40"
              />
            </span>
          )}
          <Select
            value={granularity}
            onChange={(e) => setGranularity(e.target.value as FinopsGranularity | '')}
            aria-label="Time-series interval"
            title="Time-series bucket size"
          >
            <option value="">Auto interval</option>
            {GRANULARITIES.map((g) => (
              <option key={g} value={g}>
                by {g}
              </option>
            ))}
          </Select>
          <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
            <span className="text-body-sm text-fg-muted">Compare to</span>
            <Select
              value={compareMode}
              onChange={(e) => setCompareMode(e.target.value as 'off' | 'previous' | 'custom')}
              aria-label="Comparison baseline"
            >
              <option value="off">No comparison</option>
              <option value="previous">Previous period (auto)</option>
              <option value="custom">Custom baseline…</option>
            </Select>
            {compareMode === 'custom' && (
              <span className="flex items-center gap-2">
                <Input
                  type="date"
                  value={compareFrom}
                  onChange={(e) => setCompareFrom(e.target.value)}
                  aria-label="Baseline start"
                  title="Baseline start"
                  className="w-40"
                />
                <ArrowRight className="size-4 text-fg-faint" aria-hidden />
                <Input
                  type="date"
                  value={compareTo}
                  onChange={(e) => setCompareTo(e.target.value)}
                  aria-label="Baseline end (inclusive)"
                  title="Baseline end (inclusive)"
                  className="w-40"
                />
              </span>
            )}
          </div>
        </ControlRow>

        <ControlRow label="Scope" className="px-4 py-3 md:px-5">
          <Select
            icon={Building2}
            value={tenantId}
            onChange={(e) => {
              setTenantId(e.target.value);
              setSubscriptionId('');
              setResourceGroupId('');
            }}
            aria-label="Organization"
            selectClassName="max-w-[15rem]"
          >
            <option value="">All organizations</option>
            {orgs.data?.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
          <Select
            icon={KeyRound}
            value={subscriptionId}
            onChange={(e) => {
              setSubscriptionId(e.target.value);
              setResourceGroupId('');
            }}
            aria-label="Subscription"
            selectClassName="max-w-[15rem]"
          >
            <option value="">All subscriptions</option>
            {orgSubs.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
          <Select
            icon={FolderTree}
            value={resourceGroupId}
            onChange={(e) => setResourceGroupId(e.target.value)}
            disabled={!subscriptionId}
            aria-label="Resource group"
            title={subscriptionId ? '' : 'Pick a subscription first'}
            selectClassName="max-w-[15rem]"
          >
            <option value="">All resource groups</option>
            {rgs.data?.map((rg) => (
              <option key={rg.id} value={rg.id}>
                {rg.name}
              </option>
            ))}
          </Select>
          {scopeActive && (
            <TextButton
              tone="muted"
              onClick={() => {
                setTenantId('');
                setSubscriptionId('');
                setResourceGroupId('');
              }}
            >
              Clear scope
            </TextButton>
          )}
        </ControlRow>

        <ControlRow label="Break down by" className="px-4 py-3 md:px-5">
          <Select
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as FinopsGroupBy)}
            aria-label="Break down by"
          >
            <optgroup label="Where it is">
              {GROUP_BY.filter((g) => g.kind === 'scope').map((g) => (
                <option key={g.key} value={g.key}>
                  {g.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="What it is / who owns it">
              {GROUP_BY.filter((g) => g.kind === 'attribute').map((g) => (
                <option key={g.key} value={g.key}>
                  {g.label}
                </option>
              ))}
            </optgroup>
          </Select>
          {groupBy === 'tag' && (
            <Select value={tagKey} onChange={(e) => setTagKey(e.target.value)} aria-label="Tag key">
              <option value="">Choose a tag…</option>
              {facets.data?.tagKeys.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
          )}
          {isFetching && !isLoading && <Spinner className="lg:ml-auto" label="Updating…" />}
        </ControlRow>
      </Panel>

      {isLoading ? (
        <div className="space-y-4" role="status" aria-label="Loading cost data">
          <Skeleton className="h-6 w-72" />
          <div className="overflow-hidden rounded-md border border-line bg-surface">
            <div className="cell-grid grid-cols-2 md:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="space-y-3 p-5">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-7 w-24" />
                </div>
              ))}
            </div>
          </div>
          <Skeleton className="h-72 rounded-md" />
        </div>
      ) : isError ? (
        <ErrorState
          title="Couldn’t load cost data"
          error={error}
          onRetry={() => void refetch()}
          retrying={isRefetching}
        />
      ) : !data ? null : !data.hasData ? (
        <EmptyState
          icon={CircleDollarSign}
          title="No cost data for this selection"
          description="Try a wider period or clear the filter. If you’ve never synced, run a cost sync — the service principal needs Cost Management Reader on each subscription."
          action={
            canSync && (
              <Button icon={RefreshCw} onClick={startSync} loading={sync.isPending}>
                Sync costs now
              </Button>
            )
          }
        />
      ) : (
        <div
          className={cn('space-y-4 transition-opacity duration-150', isFetching && 'opacity-70')}
        >
          {/* Date-range banner — always tells you exactly what you're looking at */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-body-sm">
            <span className="inline-flex items-center gap-2 rounded-xs border border-accent/25 bg-accent/10 px-2 py-1 font-mono text-caption text-accent">
              <CalendarRange className="size-3.5" aria-hidden />
              {fmtRange(data.range.from, data.range.to)}
            </span>
            <span className="font-mono text-caption text-fg-muted">{data.range.days} days</span>
            {data.previousRange &&
              (data.previousComplete ? (
                <span className="text-fg-muted">
                  compared to{' '}
                  <span className="font-mono text-caption text-fg-secondary">
                    {fmtRange(data.previousRange.from, data.previousRange.to)}
                  </span>
                </span>
              ) : (
                <span className="text-warning">
                  Not enough history to compare (cost data starts{' '}
                  {data.earliestData ? fmtDay(data.earliestData) : '—'} — try a shorter period)
                </span>
              ))}
          </div>

          <KpiRow data={data} currency={currency} showCompare={showCompare} />

          <Panel
            title={`Cost trend · by ${data.granularity}`}
            actions={
              showCompare ? (
                <span className="flex items-center gap-4 text-caption text-fg-muted">
                  <span className="flex items-center gap-1.5">
                    <span className="h-0.5 w-4 rounded-full bg-accent" aria-hidden /> This period
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-0 w-4 border-t border-dashed border-fg-muted" aria-hidden />{' '}
                    Previous
                  </span>
                </span>
              ) : undefined
            }
          >
            <ReactECharts
              option={trendOption(data.series, currency, showCompare)}
              style={{ height: 300 }}
              notMerge
            />
          </Panel>

          <Panel
            flush
            title={
              <span className="flex items-center gap-2">
                By {GROUP_LABEL[data.groupBy]}
                <span className="font-mono text-body-sm font-normal tabular-nums text-fg-muted">
                  {data.breakdown.length}
                </span>
              </span>
            }
            description={
              NEXT_LEVEL[data.groupBy]
                ? `Select a row to drill into its ${GROUP_LABEL[NEXT_LEVEL[data.groupBy]!]}s`
                : data.groupBy === 'resource'
                  ? 'Select a resource to open it'
                  : data.groupBy === 'tag' && !tagKey
                    ? 'Choose a tag above to split cost by its values (showback / chargeback)'
                    : 'Select a row to see those resources in the inventory'
            }
            actions={
              <Button
                variant="secondary"
                size="sm"
                icon={Download}
                onClick={() => exportBreakdown(data, showCompare)}
                disabled={data.breakdown.length === 0}
              >
                CSV
              </Button>
            }
          >
            <BreakdownTable
              data={data}
              currency={currency}
              showCompare={showCompare}
              onDrill={drill}
              tagKey={tagKey}
            />
          </Panel>
        </div>
      )}

      <div id="finops-anomalies" className="mt-6 scroll-mt-4">
        <AnomaliesPanel tenantId={tenantId || undefined} />
      </div>

      {overview.data && (
        <div className="mt-6 space-y-4">
          <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
            <div id="finops-budgets" className="scroll-mt-4">
              <BudgetsPanel o={overview.data} canManage={can('finops.budget.manage')} />
            </div>
            <div id="finops-savings" className="scroll-mt-4">
              <SavingsPanel o={overview.data} />
            </div>
          </div>
          <div id="finops-unattributed" className="scroll-mt-4">
            <UnattributedPanel o={overview.data} />
          </div>
        </div>
      )}

      <div id="finops-sync" className="scroll-mt-4">
        <CostSyncPanel tenantId={tenantId || undefined} />
      </div>
    </div>
  );
}

function KpiRow({
  data,
  currency,
  showCompare,
}: {
  data: FinopsQueryResult;
  currency: string;
  showCompare: boolean;
}) {
  const canCompare = showCompare && data.deltaAbs != null;
  const saved = canCompare && (data.deltaAbs as number) < 0;
  const up = canCompare && (data.deltaAbs as number) > 0;

  const deltaValue = canCompare
    ? `${saved ? '−' : up ? '+' : ''}${money(Math.abs(data.deltaAbs as number), currency)}`
    : '—';
  const deltaTone = !canCompare ? undefined : saved ? 'success' : up ? 'danger' : undefined;
  const deltaHint = canCompare
    ? `${saved ? 'saved · was' : 'was'} ${money(data.previousTotal ?? 0, currency)}`
    : data.previousRange
      ? 'not enough history'
      : 'comparison off';

  return (
    <ReadoutGrid className="grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
      <Readout
        label={`Total · ${data.range.days}d`}
        value={money(data.total, currency)}
        hint={fmtRange(data.range.from, data.range.to)}
      />
      <Readout
        label="vs previous"
        badge={canCompare ? <DeltaBadge pct={data.deltaPct} /> : undefined}
        value={<span className={canCompare ? undefined : 'text-fg-faint'}>{deltaValue}</span>}
        tone={deltaTone}
        hint={deltaHint}
      />
      <Readout label="Avg / day" value={money(data.total / data.range.days, currency)} hint="" />
      <Readout
        label="Projected / month"
        value={money((data.total / data.range.days) * 30, currency)}
        hint="at the current daily average"
      />
    </ReadoutGrid>
  );
}

function BreakdownTable({
  data,
  currency,
  showCompare,
  onDrill,
  tagKey,
}: {
  data: FinopsQueryResult;
  currency: string;
  showCompare: boolean;
  onDrill: (r: FinopsBreakdownRow) => void;
  tagKey: string;
}) {
  const drillable = (r: FinopsBreakdownRow) =>
    Boolean(r.scopeId) || inventoryHref(r, tagKey) !== null;
  const total = Math.max(data.total, 0.0001);
  return (
    <div className="overflow-x-auto">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col" className="hidden w-[22%] sm:table-cell">
              Share
            </th>
            <th scope="col" className="num">
              <span className="sm:hidden">Cost</span>
              <span className="hidden sm:inline">Cost · this period</span>
            </th>
            {showCompare && (
              <th scope="col" className="num hidden md:table-cell">
                Previous period
              </th>
            )}
            {showCompare && (
              <th scope="col" className="num">
                Change
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {data.breakdown.map((r) => {
            const share = (r.cost / total) * 100;
            return (
              <tr
                key={r.key}
                data-interactive={drillable(r) || undefined}
                onClick={() => drillable(r) && onDrill(r)}
              >
                <td className="max-w-[9rem] sm:max-w-[22rem]">
                  {drillable(r) ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDrill(r);
                      }}
                      className="group inline-flex max-w-full items-center gap-1.5 rounded-xs text-left font-medium text-fg transition-colors duration-150 hover:text-accent"
                      title={
                        r.scopeType === 'resource'
                          ? 'Open resource'
                          : NEXT_LEVEL[r.scopeType]
                            ? `Drill into this ${GROUP_LABEL[r.scopeType]}`
                            : 'Show these resources in the inventory'
                      }
                    >
                      <span className="truncate">{r.label}</span>
                      <ArrowRight
                        className={cn(
                          'size-3.5 shrink-0 text-fg-faint transition-[color,transform] duration-150 group-hover:text-accent',
                          r.scopeType === 'resource' || !NEXT_LEVEL[r.scopeType]
                            ? '-rotate-45'
                            : 'rotate-90',
                        )}
                        aria-hidden
                      />
                    </button>
                  ) : (
                    <span className="truncate text-fg-secondary">{r.label}</span>
                  )}
                </td>
                <td className="hidden sm:table-cell">
                  <div className="flex items-center gap-2">
                    <Meter value={share} size="sm" />
                    <span className="w-10 shrink-0 text-right font-mono text-caption tabular-nums text-fg-muted">
                      {share >= 10 ? Math.round(share) : share.toFixed(1)}%
                    </span>
                  </div>
                </td>
                <td className="num text-fg">{money(r.cost, currency)}</td>
                {showCompare && (
                  <td className="num hidden text-fg-muted md:table-cell">
                    {r.previousCost != null ? money(r.previousCost, currency) : '—'}
                  </td>
                )}
                {showCompare && (
                  <td className="num">
                    <DeltaBadge pct={r.deltaPct} />
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function trendOption(series: FinopsSeriesPoint[], currency: string, compare: boolean) {
  const c = chartColors();
  const seriesDefs: Record<string, unknown>[] = [
    trendSeries(
      c,
      'This period',
      series.map((p) => p.cost),
    ),
  ];
  if (compare) {
    seriesDefs.push({
      name: 'Previous',
      type: 'line',
      smooth: 0.25,
      showSymbol: false,
      data: series.map((p) => p.previousCost ?? 0),
      lineStyle: { color: c.fgMuted, type: 'dashed', width: 1.5 },
      itemStyle: { color: c.fgMuted },
    });
  }
  return {
    grid: { left: 4, right: 12, top: 12, bottom: 4, containLabel: true },
    tooltip: {
      trigger: 'axis',
      ...tooltipStyle(c),
      axisPointer: { type: 'line', lineStyle: { color: c.lineStrong } },
      // Show both the current bucket date and the aligned previous-period date.
      formatter: (params: { dataIndex: number }[]) => {
        const i = params[0]?.dataIndex ?? 0;
        const p = series[i];
        if (!p) return '';
        const lines = [
          `<div style="display:flex;justify-content:space-between;gap:16px"><span>${p.bucket}</span><b style="font-family:${MONO}">${money(Math.round(p.cost), currency)}</b></div>`,
        ];
        if (compare) {
          lines.push(
            `<div style="display:flex;justify-content:space-between;gap:16px;color:${c.fgMuted}"><span>${p.previousBucket ?? 'prev'}</span><span style="font-family:${MONO}">${money(Math.round(p.previousCost ?? 0), currency)}</span></div>`,
          );
        }
        return lines.join('');
      },
    },
    xAxis: categoryAxis(
      c,
      series.map((p) => p.bucket),
    ),
    yAxis: valueAxis(c, (v) => compactMoney(v, currency)),
    series: seriesDefs,
  };
}
