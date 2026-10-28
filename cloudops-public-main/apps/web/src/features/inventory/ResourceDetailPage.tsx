import { useId, useMemo, useState } from 'react';
import { ReactECharts } from '../../lib/echarts';
import axios from 'axios';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  BookText,
  CircleCheck,
  CircleDollarSign,
  CircleX,
  ClipboardList,
  ExternalLink,
  History,
  Info,
  ListChecks,
  MapPin,
  Network,
  Plus,
  RefreshCw,
  SearchX,
  ChevronRight,
  Lock,
  ShieldAlert,
  ShieldCheck,
  SquareKanban,
  Wallet,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { RemediationActionDto, ResourceActivityDto, ResourceComplianceDto, ResourceDetailDto } from '@cloudops/core';
import {
  useEvaluateResource,
  useRefreshResource,
  useRemediationActions,
  useResource,
  useResourceActivity,
  useResourceCompliance,
  useResourceCostTrend,
  useResourceHistory,
  useWorkItems,
} from '../../lib/queries';
import { usePermissions } from '../../lib/auth';
import { apiErrorMessage } from '../../lib/api';
import { useRecordVisit } from '../../lib/recent';
import { categoryAxis, chartColors, tooltipStyle, trendSeries, valueAxis } from '../../lib/chartTheme';
import { ScopedTasks } from '../work/ScopedTasks';
import { ScopedDocs } from '../workspaces/ScopedDocs';
import { ResourceCompliance } from '../standards/ResourceCompliance';
import { useCreateWork } from '../work/CreateWork';
import { TagEditor } from './TagEditor';
import { lifecycleTone } from './lifecycle';
import { dailyCost, money, shortType, moneyFull } from '../../lib/format';
import {
  Alert,
  Badge,
  DescriptionList,
  EmptyState,
  ErrorState,
  LoadingBlock,
  Menu,
  MonoId,
  PageHeader,
  Panel,
  Readout,
  ReadoutGrid,
  Skeleton,
  TabPanel,
  Tabs,
  cn,
  scoreTone,
  severityTone,
  type MenuItem,
} from '../../components/ui/primitives';
import { useToast } from '../../components/ui/Toast';
import { RiskBadge } from '../remediation/shared';

const TABS = ['Overview', 'Activity', 'Cost', 'Compliance', 'Security', 'Dependencies', 'Work', 'History', 'Docs'] as const;
type Tab = (typeof TABS)[number];
/** Older deep links used these names. */
const LEGACY_TABS: Record<string, Tab> = { Tasks: 'Work', Lifecycle: 'History' };
const TAB_ICONS: Record<Tab, LucideIcon> = {
  Overview: Info,
  Activity: Activity,
  Cost: Wallet,
  Compliance: ListChecks,
  Security: ShieldCheck,
  Dependencies: Network,
  Work: SquareKanban,
  History: History,
  Docs: BookText,
};

const muted = (s: string) => <span className="text-fg-muted">{s}</span>;

/* ── Overview ──────────────────────────────────────────────────────────── */

function AtAGlance({ data, compliance, openWork, onTab }: { data: ResourceDetailDto; compliance?: ResourceComplianceDto; openWork: number; onTab: (t: Tab) => void }) {
  const high = compliance?.results.filter((r) => !r.passed && !r.exempt && r.severity === 'high').length ?? 0;
  const cell = 'block h-full w-full cursor-pointer text-left';
  return (
    <ReadoutGrid className="mb-4 grid-cols-2 lg:grid-cols-5">
      <button type="button" className={cell} onClick={() => onTab('Compliance')}>
        <Readout
          size="sm"
          label="Compliance"
          value={compliance && compliance.results.length ? compliance.score : '—'}
          tone={compliance && compliance.results.length ? scoreTone(compliance.score) : undefined}
          hint={compliance ? (compliance.failed ? `${compliance.failed} failing${high ? ` · ${high} high` : ''}` : 'all passing') : 'loading…'}
          className="h-full"
        />
      </button>
      <button type="button" className={cell} onClick={() => onTab('Cost')}>
        <Readout
          size="sm"
          label="Monthly cost"
          value={data.costMonthly != null ? money(data.costMonthly, data.costCurrency) : '—'}
          hint={dailyCost(data.dailyCost, data.costCurrency) === '—' ? 'no cost data' : `${dailyCost(data.dailyCost, data.costCurrency)} (7d avg)`}
          className="h-full"
        />
      </button>
      <button type="button" className={cell} onClick={() => onTab('Dependencies')}>
        <Readout size="sm" label="Dependencies" value={data.relationships.length} hint={`${data.dependents.length} depend on it`} className="h-full" />
      </button>
      <button type="button" className={cell} onClick={() => onTab('Work')}>
        <Readout size="sm" label="Open work" value={openWork} hint="linked work items" className="h-full" />
      </button>
      <div className="h-full">
        <Readout
          size="sm"
          label="Owner"
          value={<span className="text-body">{data.owner ?? '—'}</span>}
          hint={data.owner ? 'from the owner tag' : 'nobody is accountable'}
          tone={data.owner ? undefined : 'warning'}
          className="h-full"
        />
      </div>
    </ReadoutGrid>
  );
}

function OverviewTab({ data }: { data: ResourceDetailDto }) {
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <Panel title="Properties">
        <DescriptionList
          items={[
            { label: 'Owner', value: data.owner ?? muted('unassigned') },
            { label: 'Provider', value: data.providerKey },
            { label: 'Type', value: data.type, mono: true },
            { label: 'Category', value: data.category ?? '—' },
            { label: 'SKU', value: data.sku ?? '—' },
            { label: 'Location', value: data.location ?? '—' },
            {
              label: 'Created (provider)',
              value: data.azureCreatedAt ? new Date(data.azureCreatedAt).toLocaleString() : '—',
            },
            {
              label: 'Retire by',
              value: data.retireBy ? new Date(data.retireBy).toLocaleDateString() : muted('not set'),
            },
            {
              label: 'In use',
              value:
                data.inUse == null ? (
                  muted('unknown')
                ) : data.inUse ? (
                  <Badge tone="success" dot>
                    Yes
                  </Badge>
                ) : (
                  <Badge tone="warning" dot>
                    Idle
                  </Badge>
                ),
            },
            {
              label: 'Daily cost (7d avg)',
              value: <span className="font-mono">{dailyCost(data.dailyCost, data.costCurrency)}</span>,
            },
            {
              label: 'Organization',
              value: data.organizationName ? (
                <Link to={`/organizations#${data.organizationId}`} className="link">
                  {data.organizationName}
                </Link>
              ) : (
                '—'
              ),
            },
            {
              label: 'Subscription',
              value: data.subscriptionId ? (
                <Link to={`/resource-groups?subscriptionId=${data.subscriptionId}`} className="link">
                  {data.subscriptionName ?? 'resource groups'}
                </Link>
              ) : (
                '—'
              ),
            },
            {
              label: 'Resource group',
              value: data.resourceGroupId ? (
                <Link to={`/inventory?resourceGroupId=${data.resourceGroupId}`} className="link">
                  {data.resourceGroupName ?? 'resources'}
                </Link>
              ) : (
                '—'
              ),
            },
            { label: 'Last synced', value: data.lastSyncedAt ? new Date(data.lastSyncedAt).toLocaleString() : '—' },
            { label: 'Resource id', value: <MonoId value={data.externalId} /> },
          ]}
        />
      </Panel>

      <TagEditor resource={data} />
    </div>
  );
}

/* ── Activity ──────────────────────────────────────────────────────────── */

const ACTIVITY_ICON: Record<ResourceActivityDto['kind'], LucideIcon> = {
  change: RefreshCw,
  lifecycle: History,
  audit: ClipboardList,
  remediation: Wrench,
  work: SquareKanban,
  exemption: ShieldAlert,
};

function ActivityTab({ resourceId }: { resourceId: string }) {
  const activity = useResourceActivity(resourceId);
  if (activity.isLoading) return <LoadingBlock label="Loading activity…" />;
  if (activity.isError) return <ErrorState compact error={activity.error} onRetry={() => void activity.refetch()} />;
  const items = activity.data ?? [];
  if (!items.length) {
    return (
      <EmptyState
        icon={Activity}
        title="No activity yet"
        description="Configuration changes found by sync, tag writes, remediations, work items and exemptions for this resource show up here, newest first."
      />
    );
  }
  return (
    <Panel title="Activity" description="Everything that happened to this resource — from sync, people and CloudOps itself">
      <ol className="relative ml-2 border-l border-line">
        {items.map((a) => {
          const Icon = ACTIVITY_ICON[a.kind];
          const body = (
            <>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="text-body-sm font-medium text-fg">{a.title}</span>
                <span className="font-mono text-caption text-fg-muted">{new Date(a.at).toLocaleString()}</span>
                {a.actor && <span className="text-caption text-fg-muted">· {a.actor}</span>}
              </div>
              {a.detail && <div className="mt-0.5 break-words font-mono text-caption text-fg-secondary">{a.detail}</div>}
            </>
          );
          return (
            <li key={a.id} className="relative pb-4 pl-7 last:pb-0">
              <span className="absolute -left-3 top-0 grid size-6 place-items-center rounded-full border border-line bg-surface text-fg-muted">
                <Icon className="size-3" aria-hidden />
              </span>
              {a.link ? (
                <Link to={a.link} className="group block rounded-xs hover:text-accent">
                  {body}
                </Link>
              ) : (
                body
              )}
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}

/* ── Cost ──────────────────────────────────────────────────────────────── */

function CostTab({ resourceId }: { resourceId: string }) {
  const trend = useResourceCostTrend(resourceId);
  if (trend.isLoading) return <LoadingBlock label="Loading cost…" />;
  const t = trend.data;
  const cur = t?.currency ?? '';
  const fmt = (n: number | null | undefined) => moneyFull(n ?? 0, cur, 2);

  if (!t || t.points.length === 0) {
    return (
      <EmptyState
        icon={CircleDollarSign}
        title="No cost data for this resource"
        description="Run a cost sync from the FinOps page. Cost Management doesn’t report line-item cost for every resource type — some bill through a parent (a plan, a server)."
        action={
          <Link to="/finops" className="link text-body-sm">
            Open FinOps
          </Link>
        }
      />
    );
  }

  const c = chartColors();
  const option = {
    grid: { left: 4, right: 12, top: 16, bottom: 4, containLabel: true },
    tooltip: { trigger: 'axis', ...tooltipStyle(c) },
    xAxis: categoryAxis(c, t.points.map((p) => p.date)),
    yAxis: valueAxis(c),
    series: [trendSeries(c, 'Daily cost', t.points.map((p) => p.cost))],
  };

  return (
    <div className="space-y-4">
      <ReadoutGrid className="grid-cols-1 sm:grid-cols-3">
        <Readout label="Daily (avg)" value={fmt(t.costDaily)} size="sm" />
        <Readout label="Monthly" value={fmt(t.costMonthly)} size="sm" />
        <Readout label="Window total" value={fmt(t.totalWindow)} size="sm" />
      </ReadoutGrid>
      <Panel title="Daily cost trend">
        <ReactECharts option={option} style={{ height: 280 }} />
      </Panel>
    </div>
  );
}

/* ── Security ──────────────────────────────────────────────────────────── */

const SECURITY_GROUPS: { label: string; icon: LucideIcon; keys: string[]; why: string }[] = [
  { label: 'Exposure', icon: ShieldAlert, keys: ['public-network-restricted', 'storage-no-public-blob', 'vm-no-public-ip'], why: 'What can be reached from the internet.' },
  { label: 'Identity & access', icon: Lock, keys: ['managed-identity', 'keyvault-rbac', 'acr-admin-disabled', 'local-auth-disabled'], why: 'How callers prove who they are.' },
  { label: 'Encryption in transit', icon: Lock, keys: ['https-only', 'storage-secure-transfer', 'min-tls-1-2', 'redis-tls-only'], why: 'Whether traffic can travel unencrypted.' },
  { label: 'Data protection', icon: ShieldCheck, keys: ['keyvault-soft-delete', 'keyvault-purge-protection'], why: 'Recovery from accidental or malicious deletion.' },
];

function SecurityTab({ resourceId }: { resourceId: string }) {
  const c = useResourceCompliance(resourceId);
  if (c.isLoading) return <LoadingBlock label="Loading security checks…" />;
  const security = (c.data?.results ?? []).filter((r) => r.category === 'security');
  if (!security.length) {
    return (
      <EmptyState
        icon={ShieldCheck}
        title="No security checks apply to this resource type"
        description="Security rules cover exposure, identity, encryption in transit and data protection for the types that have them (web apps, storage, databases, key vaults, registries, VMs, caches)."
      />
    );
  }
  const grouped = SECURITY_GROUPS.map((g) => ({ ...g, results: security.filter((r) => g.keys.includes(r.template ?? r.ruleKey)) }));
  const known = new Set(SECURITY_GROUPS.flatMap((g) => g.keys));
  const other = security.filter((r) => !known.has(r.template ?? r.ruleKey));
  if (other.length) grouped.push({ label: 'Other', icon: ShieldCheck, keys: [], why: 'Other security checks.', results: other });
  const failing = security.filter((r) => !r.passed && !r.exempt).length;

  return (
    <div className="space-y-4">
      <Alert tone={failing ? 'warning' : 'success'} title={failing ? `${failing} security check${failing === 1 ? '' : 's'} failing` : 'Every security check passes'}>
        Derived from the configuration recorded at the last sync. Fixes that CloudOps can apply are under Actions.
      </Alert>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {grouped
          .filter((g) => g.results.length)
          .map((g) => (
            <Panel
              key={g.label}
              title={
                <span className="flex items-center gap-2">
                  <g.icon className="size-4 text-fg-muted" aria-hidden />
                  {g.label}
                </span>
              }
              description={g.why}
              flush
            >
              <ul className="divide-y divide-line-subtle">
                {g.results.map((r) => (
                  <li key={r.ruleId} className="flex items-start gap-3 px-4 py-2.5 md:px-5">
                    {r.passed ? (
                      <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-label="passing" />
                    ) : r.exempt ? (
                      <ShieldAlert className="mt-0.5 size-4 shrink-0 text-fg-muted" aria-label="exempt" />
                    ) : (
                      <CircleX className="mt-0.5 size-4 shrink-0 text-danger" aria-label="failing" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link to={`/standards?rule=${r.ruleId}`} className="link-quiet text-body-sm font-medium">
                          {r.ruleName}
                        </Link>
                        {!r.passed && <Badge tone={severityTone(r.severity)}>{r.severity}</Badge>}
                        {r.exempt && <Badge>exempt</Badge>}
                      </div>
                      {!r.passed && r.detail && <div className="mt-0.5 text-caption text-danger/90">{r.detail}</div>}
                      {!r.passed && !r.exempt && r.remediation && <div className="mt-0.5 text-caption text-fg-muted">{r.remediation}</div>}
                    </div>
                  </li>
                ))}
              </ul>
            </Panel>
          ))}
      </div>
    </div>
  );
}

/* ── Dependencies ──────────────────────────────────────────────────────── */

function DependenciesTab({ data }: { data: ResourceDetailDto }) {
  const topoLink = `/topology?focus=${data.id}`;
  if (data.relationships.length === 0 && data.dependents.length === 0) {
    return (
      <EmptyState
        icon={Network}
        title="No dependencies discovered"
        description="Edges (network, identity, RBAC, managed-by) are discovered from resource configuration on each sync. Nothing in your estate references this resource, and it references nothing in your estate."
        action={
          <Link to={topoLink} className="link inline-flex items-center gap-1 text-body-sm">
            Open in the topology <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        }
      />
    );
  }
  const list = (items: { id: string; type: string; to: string; name: string }[], empty: string) =>
    items.length === 0 ? (
      <p className="px-5 py-6 text-center text-body-sm text-fg-muted">{empty}</p>
    ) : (
      <ul className="divide-y divide-line-subtle">
        {items.map((r) => (
          <li key={r.id} className="flex items-center gap-3 px-4 py-2.5 text-body-sm md:px-5">
            <Badge tone="accent" mono className="w-24 justify-center">
              {r.type}
            </Badge>
            <Link to={`/inventory/${r.to}`} className="link-quiet min-w-0 truncate">
              {r.name}
            </Link>
          </li>
        ))}
      </ul>
    );
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Link to={topoLink} className="link inline-flex items-center gap-1 text-body-sm">
          Focus it in the topology <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel flush title={`Depends on · ${data.relationships.length}`} description="What this resource needs">
          {list(
            data.relationships.map((r) => ({ id: r.id, type: r.type, to: r.targetResourceId, name: r.targetName ?? r.targetResourceId })),
            'Depends on nothing in your estate.',
          )}
        </Panel>
        <Panel flush title={`Used by · ${data.dependents.length}`} description="What breaks or changes if this resource does — its blast radius">
          {list(
            data.dependents.map((r) => ({ id: r.id, type: r.type, to: r.sourceResourceId, name: r.sourceName ?? r.sourceResourceId })),
            'Nothing in your estate depends on it.',
          )}
        </Panel>
      </div>
    </div>
  );
}

/* ── History (lifecycle + change feed) ─────────────────────────────────── */

function HistoryTab({ resourceId }: { resourceId: string }) {
  const history = useResourceHistory(resourceId);
  if (history.isLoading) return <LoadingBlock label="Loading history…" />;
  const lc = history.data?.lifecycleEvents ?? [];
  const changes = history.data?.changeEvents ?? [];

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Panel title="Lifecycle timeline">
        {lc.length ? (
          <ol className="relative ml-1.5 border-l border-line">
            {lc.map((e) => (
              <li key={e.id} className="relative pb-5 pl-6 last:pb-0">
                <span aria-hidden className="absolute -left-[5px] top-1.5 size-[9px] rounded-full border-2 border-surface bg-accent" />
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={lifecycleTone(e.stage)}>{e.stage}</Badge>
                  <span className="text-body-sm text-fg-secondary">{e.reason ?? e.actor ?? 'sync'}</span>
                </div>
                <div className="mt-1 font-mono text-caption tabular-nums text-fg-muted">{new Date(e.createdAt).toLocaleString()}</div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="py-6 text-center text-body-sm text-fg-muted">No lifecycle events yet.</p>
        )}
      </Panel>

      <Panel title="Configuration changes" description="Detected by sync or a refresh">
        {changes.length ? (
          <ul className="divide-y divide-line-subtle">
            {changes.map((c) => (
              <li key={c.id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-body-sm text-fg-secondary">
                    <Badge mono className="mr-1.5">
                      {c.field}
                    </Badge>
                    changed
                  </span>
                  <span className="font-mono text-caption tabular-nums text-fg-muted">{new Date(c.detectedAt).toLocaleString()}</span>
                </div>
                <div className="mt-2 break-all rounded-xs border border-line-subtle bg-canvas px-2.5 py-1.5 font-mono text-caption">
                  <span className="text-fg-muted line-through decoration-fg-faint">{JSON.stringify(c.oldValue)}</span>
                  <span className="mx-1.5 text-fg-faint">→</span>
                  <span className="text-success">{JSON.stringify(c.newValue)}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-6 text-center text-body-sm text-fg-muted">No changes detected yet.</p>
        )}
      </Panel>
    </div>
  );
}

/* ── Actions ───────────────────────────────────────────────────────────── */

function useActionsMenu(data: ResourceDetailDto, compliance?: ResourceComplianceDto) {
  const { can } = usePermissions();
  const refresh = useRefreshResource();
  const evaluate = useEvaluateResource();
  const actions = useRemediationActions();
  const createWork = useCreateWork();
  const toast = useToast();
  const type = data.type.toLowerCase();
  const failingTemplates = new Set((compliance?.results ?? []).filter((r) => !r.passed && !r.exempt && r.template).map((r) => r.template!));

  const applicable = (a: RemediationActionDto) => (!a.types || a.types.includes(type)) && data.state === 'active';
  const fixes = (actions.data ?? []).filter((a) => applicable(a) && a.fixesRules.some((r) => failingTemplates.has(r)));
  const operations = (actions.data ?? []).filter((a) => applicable(a) && a.fixesRules.length === 0 && a.types);
  const tagActions = (actions.data ?? []).filter((a) => applicable(a) && a.key.startsWith('tags.') && !fixes.includes(a));
  const toItem = (a: RemediationActionDto): MenuItem => ({
    key: a.key,
    label: (
      <span className="flex items-center gap-2">
        {a.title} <RiskBadge risk={a.risk} />
      </span>
    ),
    icon: Wrench,
    hint: a.available ? a.change : a.unavailableReason,
    to: `/remediation/new?action=${a.key}&resources=${data.id}`,
    disabled: !can('remediation.request'),
  });

  const run = async (label: string, fn: () => Promise<unknown>) => {
    try {
      const out = await fn();
      const msg = out && typeof out === 'object' && 'message' in out ? String((out as { message: string }).message) : undefined;
      toast({ title: label, description: msg });
    } catch (e) {
      toast({ tone: 'danger', title: `${label} failed`, description: apiErrorMessage(e) });
    }
  };

  return {
    busy: refresh.isPending || evaluate.isPending,
    sections: [
      {
        items: [
          {
            key: 'refresh',
            label: 'Refresh from the provider',
            icon: RefreshCw,
            hint: 'Re-read it now instead of waiting for the next sync',
            disabled: !can('resource.operate') || data.state !== 'active',
            onSelect: () => void run('Refreshed', () => refresh.mutateAsync(data.id)),
          },
          {
            key: 'evaluate',
            label: 'Re-evaluate compliance',
            icon: ListChecks,
            disabled: !(can('standards.evaluate') || can('resource.operate')),
            onSelect: () => void run('Compliance re-evaluated', () => evaluate.mutateAsync(data.id)),
          },
          ...(data.portalUrl ? [{ key: 'portal', label: 'Open in the Azure portal', icon: ExternalLink, href: data.portalUrl }] : []),
          {
            key: 'work',
            label: 'Create a work item',
            icon: Plus,
            disabled: !can('work.manage'),
            onSelect: () => createWork({ scopes: [{ scopeType: 'resource', scopeId: data.id, scopeName: data.name }] }),
          },
        ] satisfies MenuItem[],
      },
      { label: 'Fix failing checks', items: fixes.map(toItem) },
      { label: 'Operate', items: operations.map(toItem) },
      { label: 'Tags', items: tagActions.map(toItem) },
    ],
  };
}

/* ── Page ──────────────────────────────────────────────────────────────── */

function DetailSkeleton() {
  return (
    <div role="status" aria-label="Loading resource">
      <Skeleton className="mb-4 h-4 w-24" />
      <Skeleton className="h-7 w-72" />
      <Skeleton className="mt-3 h-4 w-96 max-w-full" />
      <div className="mt-8 flex gap-4 border-b border-line pb-3">
        {TABS.map((t) => (
          <Skeleton key={t} className="h-4 w-16" />
        ))}
      </div>
      <div className="mt-6 space-y-3 rounded-md border border-line bg-surface p-5">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-4" />
        ))}
      </div>
    </div>
  );
}

function initialTab(requested: string | null): Tab {
  if (!requested) return 'Overview';
  if ((TABS as readonly string[]).includes(requested)) return requested as Tab;
  return LEGACY_TABS[requested] ?? 'Overview';
}

export function ResourceDetailPage() {
  const { id = '' } = useParams();
  const { data, isLoading, isError, error, refetch, isRefetching } = useResource(id);
  const compliance = useResourceCompliance(data?.id ?? null);
  const work = useWorkItems({ scopeType: 'resource', scopeId: data?.id ?? '__none__' });
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTabState] = useState<Tab>(() => initialTab(searchParams.get('tab')));
  const baseId = useId();
  const setTab = (t: Tab) => {
    setTabState(t);
    setSearchParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (t === 'Overview') next.delete('tab');
        else next.set('tab', t);
        return next;
      },
      { replace: true },
    );
  };
  useRecordVisit(
    data ? { kind: 'resource', id: data.id, title: data.name, subtitle: `${shortType(data.type)}${data.location ? ` · ${data.location}` : ''}`, link: `/inventory/${data.id}` } : null,
  );
  const openWork = useMemo(() => (work.data ?? []).filter((w) => w.state !== 'done').length, [work.data]);
  const menu = useActionsMenu(
    data ?? ({ id: '', type: '', state: 'active', relationships: [], dependents: [] } as unknown as ResourceDetailDto),
    compliance.data,
  );

  if (isLoading) return <DetailSkeleton />;
  const notFound = axios.isAxiosError(error) && error.response?.status === 404;
  if (isError && !notFound)
    return <ErrorState title="Couldn’t load this resource" error={error} onRetry={() => void refetch()} retrying={isRefetching} />;
  if (!data)
    return (
      <EmptyState
        icon={SearchX}
        title="Resource not found"
        description="It may have been removed since the last sync."
        action={
          <Link to="/inventory" className="link text-body-sm">
            Back to inventory
          </Link>
        }
      />
    );

  const failing = compliance.data?.failed ?? 0;

  return (
    <div>
      <PageHeader
        overline={data.category ?? (shortType(data.type.split('/')[0] ?? '') || 'Resource')}
        title={data.name}
        subtitle={<span className="break-all font-mono text-body-sm text-fg-muted">{data.type}</span>}
        meta={
          <>
            <Badge tone={lifecycleTone(data.lifecycleStage)} dot>
              {data.lifecycleStage ?? 'Created'}
            </Badge>
            <Badge tone={data.state === 'active' ? 'success' : 'danger'} dot>
              {data.state}
            </Badge>
            {data.location && (
              <Badge mono>
                <MapPin className="-ml-0.5 mr-0.5 inline size-3" aria-hidden />
                {data.location}
              </Badge>
            )}
            {failing > 0 && (
              <button type="button" onClick={() => setTab('Compliance')} className="rounded-xs">
                <Badge tone={severityTone(compliance.data?.results.find((r) => !r.passed && !r.exempt && r.severity === 'high') ? 'high' : 'medium')}>
                  {failing} failing check{failing === 1 ? '' : 's'}
                </Badge>
              </button>
            )}
          </>
        }
        actions={<Menu label={menu.busy ? 'Working…' : 'Actions'} icon={Wrench} sections={menu.sections} />}
      >
        {/* Where this resource lives — every level opens the inventory scoped to it. */}
        <nav aria-label="Location" className="mb-4 flex flex-wrap items-center gap-1.5 text-body-sm text-fg-muted">
          <Link to="/inventory" className="inline-flex items-center gap-1.5 rounded-xs transition-colors duration-150 hover:text-fg">
            <ArrowLeft className="size-4" aria-hidden /> Inventory
          </Link>
          {data.organizationName && (
            <>
              <ChevronRight className="size-3.5 text-fg-faint" aria-hidden />
              <Link to={`/inventory?tenantId=${data.organizationId}`} className="rounded-xs transition-colors duration-150 hover:text-fg">
                {data.organizationName}
              </Link>
            </>
          )}
          {data.subscriptionName && (
            <>
              <ChevronRight className="size-3.5 text-fg-faint" aria-hidden />
              <Link to={`/inventory?subscriptionId=${data.subscriptionId}`} className="rounded-xs transition-colors duration-150 hover:text-fg">
                {data.subscriptionName}
              </Link>
            </>
          )}
          {data.resourceGroupName && (
            <>
              <ChevronRight className="size-3.5 text-fg-faint" aria-hidden />
              <Link
                to={`/inventory?resourceGroupId=${data.resourceGroupId}`}
                className="rounded-xs font-medium text-fg-secondary transition-colors duration-150 hover:text-fg"
              >
                {data.resourceGroupName}
              </Link>
            </>
          )}
        </nav>
      </PageHeader>

      {data.state === 'deleted' && (
        <Alert tone="warning" className="mb-6" title="This resource no longer exists in the provider">
          The last full sync{data.lastSyncedAt ? ` (${new Date(data.lastSyncedAt).toLocaleString()})` : ''} didn’t find it, so it’s flagged
          deleted and excluded from totals. Its history, cost and docs are kept. If it reappears, the next sync restores it automatically.
        </Alert>
      )}

      <AtAGlance data={data} compliance={compliance.data} openWork={openWork} onTab={setTab} />

      <Tabs
        tabs={TABS.map((t) => ({ id: t, label: t, icon: TAB_ICONS[t] }))}
        value={tab}
        onChange={setTab}
        baseId={baseId}
        label="Resource sections"
        className={cn('mb-6')}
      />

      <TabPanel id={tab} baseId={baseId} key={tab}>
        {tab === 'Overview' && <OverviewTab data={data} />}
        {tab === 'Activity' && <ActivityTab resourceId={data.id} />}
        {tab === 'Cost' && <CostTab resourceId={data.id} />}
        {tab === 'Compliance' && <ResourceCompliance resourceId={data.id} />}
        {tab === 'Security' && <SecurityTab resourceId={data.id} />}
        {tab === 'Dependencies' && <DependenciesTab data={data} />}
        {tab === 'Work' && <ScopedTasks scopeType="resource" scopeId={data.id} scopeName={data.name} />}
        {tab === 'History' && <HistoryTab resourceId={data.id} />}
        {tab === 'Docs' && <ScopedDocs scopeType="resource" scopeId={data.id} scopeName={data.name} />}
      </TabPanel>
    </div>
  );
}
