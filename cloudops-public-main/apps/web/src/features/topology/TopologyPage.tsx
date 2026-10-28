import { useEffect, useMemo, useRef, useState } from 'react';
import type { EChartsReactProps } from 'echarts-for-react/lib/types';
import { ReactECharts } from '../../lib/echarts';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowRight,
  Boxes,
  Crosshair,
  FolderTree,
  KeyRound,
  Maximize2,
  Minus,
  MousePointerClick,
  Network,
  Plus,
  RotateCcw,
  Search,
  X,
} from 'lucide-react';
import {
  RELATIONSHIP_TYPES,
  TOPOLOGY_CLUSTER_BY,
  type TopologyClusterBy,
  type TopologyClusterResult,
  type TopologyNodeDto,
  type TopologyResult,
} from '@cloudops/core';
import { CATEGORY_COLORS } from '../../lib/categories';
import { useResourceGroups, useSubscriptions, useTopology, useTopologyClusters, useTopologyNeighborhood } from '../../lib/queries';
import { useOrg } from '../../lib/orgContext';
import { usePermissions } from '../../lib/auth';
import { money, shortType } from '../../lib/format';
import { MONO, SANS, chartColors, tooltipStyle } from '../../lib/chartTheme';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  IconButton,
  Input,
  PageHeader,
  Panel,
  SegmentedControl,
  Select,
  Skeleton,
  Spinner,
  cn,
  severityTone,
} from '../../components/ui/primitives';
import { useCreateWork } from '../work/CreateWork';

/** Edge colours by relationship kind. */
const EDGE_COLORS: Record<string, string> = {
  network: '#56c271',
  identity: '#8c9eff',
  rbac: '#f06868',
  contains: '#e8ae45',
  'depends-on': '#76838c',
};
const CLUSTER_LABELS: Record<TopologyClusterBy, string> = {
  resourceGroup: 'Resource group',
  subscription: 'Subscription',
  category: 'Service category',
  type: 'Resource type',
  location: 'Region',
};

type View = 'map' | 'graph' | 'focus';
/** The chart instance, as echarts-for-react hands it over. */
type ChartInstance = Parameters<NonNullable<EChartsReactProps['onChartReady']>>[0];

interface NodeParam {
  dataType?: string;
  data?: { id?: string };
}
interface TooltipParam {
  dataType?: string;
  data?: Record<string, unknown>;
}

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ── Chart options ────────────────────────────────────────────────────── */

function graphOption(data: TopologyResult, selectedId: string | null, currency: string) {
  const c = chartColors();
  const catIndex = new Map(data.categories.map((cat, i) => [cat, i]));
  const degree = new Map<string, number>();
  for (const e of data.edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  const big = data.nodes.length > 250;
  const focusId = data.focus?.id;

  const nodes = data.nodes.map((n) => {
    const color = CATEGORY_COLORS[n.category] ?? CATEGORY_COLORS.Other;
    const root = n.id === focusId;
    const risky = n.worstSeverity === 'high';
    const size = root ? 34 : Math.max(8, Math.min(40, 9 + (degree.get(n.id) ?? 0) * 3));
    return {
      id: n.id,
      name: n.id,
      node: n,
      category: catIndex.get(n.category) ?? 0,
      symbolSize: size,
      itemStyle: {
        color,
        opacity: n.external ? 0.45 : n.hop && n.hop > 1 ? 0.75 : 1,
        borderColor: n.id === selectedId ? c.fg : root ? c.accent : risky ? '#f06868' : c.surface,
        borderWidth: n.id === selectedId || root ? 3 : risky ? 2.5 : 1.5,
        borderType: n.external ? 'dashed' : 'solid',
      },
    };
  });

  return {
    textStyle: { fontFamily: SANS },
    tooltip: {
      confine: true,
      ...tooltipStyle(c),
      formatter: (p: TooltipParam) => {
        if (p.dataType === 'edge') return esc(String(p.data?.type ?? ''));
        const n = p.data?.node as TopologyNodeDto | undefined;
        if (!n) return '';
        return [
          `<div style="font-weight:600;margin-bottom:2px">${esc(n.name)}</div>`,
          `<div style="color:${c.fgMuted};font-family:${MONO};font-size:11px">${esc(shortType(n.type))}</div>`,
          `<div style="margin-top:6px">owner: <span style="color:${c.fgSecondary}">${esc(n.owner ?? '—')}</span></div>`,
          n.costMonthly != null ? `<div>monthly cost: <span style="font-family:${MONO}">${esc(money(n.costMonthly, currency))}</span></div>` : '',
          n.failingChecks ? `<div style="color:${n.worstSeverity === 'high' ? '#f06868' : c.fgSecondary}">${n.failingChecks} failing check(s) · worst ${esc(n.worstSeverity)}</div>` : '',
          n.hop !== undefined ? `<div style="color:${c.fgMuted}">${n.hop === 0 ? 'focused resource' : `${n.hop} hop(s) away`}</div>` : '',
          n.external ? `<div style="color:${c.fgMuted};margin-top:4px">(outside the current scope)</div>` : '',
        ].join('');
      },
    },
    legend: [
      {
        type: 'scroll',
        top: 0,
        left: 0,
        right: 0,
        data: data.categories,
        icon: 'circle',
        itemWidth: 8,
        itemHeight: 8,
        itemGap: 16,
        textStyle: { color: c.fgSecondary, fontSize: 12 },
        backgroundColor: c.surface,
        padding: [10, 12],
        inactiveColor: c.lineStrong,
        pageTextStyle: { color: c.fgMuted },
        pageIconColor: c.fgSecondary,
        pageIconInactiveColor: c.lineStrong,
      },
    ],
    series: [
      {
        type: 'graph',
        layout: 'force',
        roam: true,
        draggable: !big,
        top: 44,
        // Small neighbourhoods would otherwise sit tiny in the middle of the canvas.
        zoom: data.nodes.length <= 12 ? 2 : data.nodes.length <= 40 ? 1.4 : 1,
        categories: data.categories.map((cat) => ({ name: cat, itemStyle: { color: CATEGORY_COLORS[cat] ?? CATEGORY_COLORS.Other } })),
        force: { repulsion: focusId ? 220 : 130, edgeLength: focusId ? [90, 200] : [60, 180], gravity: 0.08, friction: 0.6, layoutAnimation: !big },
        label: {
          show: data.nodes.length <= 80,
          position: 'right',
          color: c.fgSecondary,
          fontSize: 10,
          formatter: (p: TooltipParam) => String((p.data?.node as TopologyNodeDto | undefined)?.name ?? ''),
        },
        labelLayout: { hideOverlap: true },
        emphasis: { focus: 'adjacency', label: { show: true, color: c.fg }, lineStyle: { width: 3 } },
        edgeSymbol: ['none', 'arrow'],
        edgeSymbolSize: 7,
        data: nodes,
        edges: data.edges.map((e) => ({
          source: e.source,
          target: e.target,
          type: e.type,
          lineStyle: { color: EDGE_COLORS[e.type] ?? EDGE_COLORS['depends-on'], opacity: 0.6, width: 1.2, curveness: 0.08 },
        })),
      },
    ],
  };
}

function mapOption(data: TopologyClusterResult, currency: string) {
  const c = chartColors();
  const max = Math.max(1, ...data.clusters.map((x) => x.resources));
  return {
    textStyle: { fontFamily: SANS },
    tooltip: {
      confine: true,
      ...tooltipStyle(c),
      formatter: (p: TooltipParam) => {
        if (p.dataType === 'edge') {
          const types = (p.data?.types ?? {}) as Record<string, number>;
          return `${esc(p.data?.count)} edge(s)<br/>${Object.entries(types)
            .map(([k, v]) => `${esc(k)}: ${v}`)
            .join('<br/>')}`;
        }
        const d = p.data ?? {};
        return [
          `<div style="font-weight:600">${esc(d.label)}</div>`,
          d.context ? `<div style="color:${c.fgMuted}">${esc(d.context)}</div>` : '',
          d.external ? `<div style="color:${c.fgMuted}">outside the current scope</div>` : `<div style="margin-top:4px">${esc(d.resources)} resource(s)</div>`,
          Number(d.costMonthly) > 0 ? `<div>${esc(money(Number(d.costMonthly), currency))}/month</div>` : '',
          Number(d.failing) > 0 ? `<div style="color:#f06868">${esc(d.failing)} with high-severity findings</div>` : '',
          `<div style="color:${c.fgMuted};margin-top:4px">Click to open its resources</div>`,
        ].join('');
      },
    },
    series: [
      {
        type: 'graph',
        layout: 'force',
        roam: true,
        draggable: true,
        force: { repulsion: 420, edgeLength: [110, 260], gravity: 0.06 },
        label: {
          show: true,
          position: 'bottom',
          color: c.fgSecondary,
          fontSize: 11,
          formatter: (p: TooltipParam) => `${String(p.data?.label ?? '')}${p.data?.external ? '' : ` · ${p.data?.resources}`}`,
        },
        labelLayout: { hideOverlap: true },
        emphasis: { focus: 'adjacency', lineStyle: { width: 4 } },
        edgeSymbol: ['none', 'arrow'],
        edgeSymbolSize: 8,
        data: data.clusters.map((x) => ({
          ...x,
          name: x.id || '__none__',
          symbolSize: x.external ? 16 : 18 + 42 * Math.sqrt(x.resources / max),
          itemStyle: {
            color: CATEGORY_COLORS[x.category] ?? CATEGORY_COLORS.Other,
            opacity: x.external ? 0.4 : 0.95,
            borderColor: x.failing > 0 ? '#f06868' : c.surface,
            borderWidth: x.failing > 0 ? 2.5 : 1.5,
            borderType: x.external ? 'dashed' : 'solid',
          },
        })),
        edges: data.links.map((l) => ({
          source: l.source || '__none__',
          target: l.target || '__none__',
          count: l.count,
          types: l.types,
          lineStyle: { color: c.fgMuted, opacity: 0.55, width: Math.min(8, 1 + Math.log2(1 + l.count)), curveness: 0.1 },
        })),
      },
    ],
  };
}

/* ── Side panel ───────────────────────────────────────────────────────── */

function NodePanel({
  node,
  data,
  currency,
  onClose,
  onSelect,
  onFocus,
}: {
  node: TopologyNodeDto;
  data: TopologyResult;
  currency: string;
  onClose: () => void;
  onSelect: (id: string) => void;
  onFocus: (id: string, direction: 'both' | 'out' | 'in') => void;
}) {
  const { can } = usePermissions();
  const createWork = useCreateWork();
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const out = data.edges.filter((e) => e.source === node.id);
  const inc = data.edges.filter((e) => e.target === node.id);
  const row = (id: string, type: string) => {
    const other = byId.get(id);
    return (
      <li key={`${type}-${id}`}>
        <button type="button" onClick={() => onSelect(id)} className="flex w-full items-center gap-2 rounded-xs px-1.5 py-1 text-left text-body-sm hover:bg-hover">
          <span className="h-0.5 w-3 shrink-0 rounded-full" style={{ backgroundColor: EDGE_COLORS[type] ?? EDGE_COLORS['depends-on'] }} aria-hidden />
          <span className="min-w-0 flex-1 truncate text-fg-secondary">{other?.name ?? id}</span>
          <span className="shrink-0 font-mono text-[10px] text-fg-muted">{type}</span>
        </button>
      </li>
    );
  };
  return (
    <aside aria-label="Selected resource" className="flex min-h-0 flex-col rounded-md border border-line bg-surface">
      <div className="flex items-start justify-between gap-2 border-b border-line-subtle p-4">
        <div className="min-w-0">
          <div className="break-words text-h4 text-fg">{node.name}</div>
          <div className="mt-0.5 font-mono text-caption text-fg-muted">{shortType(node.type)}</div>
        </div>
        <IconButton icon={X} label="Close" size="sm" onClick={onClose} />
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <div className="flex flex-wrap gap-1.5">
          <Badge>{node.category}</Badge>
          {node.external && <Badge>outside scope</Badge>}
          {node.failingChecks ? <Badge tone={severityTone(node.worstSeverity ?? 'low')}>{node.failingChecks} failing</Badge> : <Badge tone="success">no findings</Badge>}
        </div>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-body-sm">
          <dt className="text-fg-muted">Owner</dt>
          <dd className="text-right text-fg-secondary">{node.owner ?? '—'}</dd>
          <dt className="text-fg-muted">Monthly cost</dt>
          <dd className="text-right font-mono text-fg-secondary">{node.costMonthly != null ? money(node.costMonthly, currency) : '—'}</dd>
          <dt className="text-fg-muted">Region</dt>
          <dd className="text-right font-mono text-caption text-fg-secondary">{node.location ?? '—'}</dd>
        </dl>
        <div>
          <div className="mb-1 font-mono text-overline uppercase text-fg-muted">Depends on · {out.length}</div>
          {out.length ? <ul>{out.map((e) => row(e.target, e.type))}</ul> : <p className="text-caption text-fg-muted">Nothing in this view.</p>}
        </div>
        <div>
          <div className="mb-1 font-mono text-overline uppercase text-fg-muted">Used by · {inc.length}</div>
          {inc.length ? <ul>{inc.map((e) => row(e.source, e.type))}</ul> : <p className="text-caption text-fg-muted">Nothing in this view.</p>}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 border-t border-line-subtle p-3">
        <Link to={`/inventory/${node.id}`} className="col-span-2 inline-flex h-8 items-center justify-center gap-1.5 rounded-sm bg-accent px-3 text-body-sm font-medium text-accent-fg hover:bg-accent-hover">
          Open resource <ArrowRight className="size-3.5" aria-hidden />
        </Link>
        <Button variant="secondary" size="sm" icon={Crosshair} onClick={() => onFocus(node.id, 'both')}>
          Focus
        </Button>
        <Button variant="secondary" size="sm" onClick={() => onFocus(node.id, 'in')}>
          Blast radius
        </Button>
        {can('work.manage') && (
          <Button
            variant="ghost"
            size="sm"
            icon={Plus}
            className="col-span-2"
            onClick={() => createWork({ scopes: [{ scopeType: 'resource', scopeId: node.id, scopeName: node.name }] })}
          >
            Work item
          </Button>
        )}
      </div>
    </aside>
  );
}

/* ── Page ─────────────────────────────────────────────────────────────── */

export function TopologyPage() {
  const [params, setParams] = useSearchParams();
  const { tenantId } = useOrg();
  const subscriptionId = params.get('subscriptionId') ?? '';
  const resourceGroupId = params.get('resourceGroupId') ?? '';
  const type = params.get('type') ?? '';
  const location = params.get('location') ?? '';
  const category = params.get('category') ?? '';
  const focus = params.get('focus') ?? '';
  const depth = Math.min(3, Math.max(1, Number(params.get('depth')) || 1));
  const direction = (['both', 'out', 'in'].includes(params.get('dir') ?? '') ? params.get('dir') : 'both') as 'both' | 'out' | 'in';
  const groupBy = ((TOPOLOGY_CLUSTER_BY as readonly string[]).includes(params.get('groupBy') ?? '') ? params.get('groupBy') : 'resourceGroup') as TopologyClusterBy;
  const rel = params.get('rel') ?? '';
  const hasScope = Boolean(subscriptionId || resourceGroupId || type || location || category);
  const view: View = focus ? 'focus' : ((params.get('view') as View | null) ?? (hasScope ? 'graph' : 'map'));

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [fitKey, setFitKey] = useState(0);
  const chart = useRef<ChartInstance | null>(null);

  const subs = useSubscriptions();
  const rgs = useResourceGroups(subscriptionId || undefined, tenantId || undefined);
  const orgSubs = useMemo(() => (tenantId ? (subs.data ?? []).filter((s) => s.tenantId === tenantId) : (subs.data ?? [])), [subs.data, tenantId]);

  const scope = {
    tenantId: tenantId || undefined,
    subscriptionId: subscriptionId || undefined,
    resourceGroupId: resourceGroupId || undefined,
    type: type || undefined,
    location: location || undefined,
    category: category || undefined,
    relTypes: rel || undefined,
  };
  const graph = useTopology(scope, view === 'graph');
  const map = useTopologyClusters({ ...scope, groupBy }, view === 'map');
  const hood = useTopologyNeighborhood(view === 'focus' ? focus : null, { depth, direction, relTypes: rel || undefined });
  const graphData = view === 'focus' ? hood.data : graph.data;
  const active = view === 'map' ? map : view === 'focus' ? hood : graph;
  const currency = (view === 'map' ? map.data?.currency : graphData?.currency) ?? '';

  function update(next: Record<string, string | undefined>) {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v) merged.set(k, v);
      else merged.delete(k);
    }
    setParams(merged, { replace: true });
    setSelectedId(null);
  }

  // Switching org (header) drops any sub/RG scope that belonged to the old org.
  const prevTenant = useRef(tenantId);
  useEffect(() => {
    if (prevTenant.current === tenantId) return;
    prevTenant.current = tenantId;
    setParams(
      (prev) => {
        if (!prev.get('subscriptionId') && !prev.get('resourceGroupId')) return prev;
        const merged = new URLSearchParams(prev);
        merged.delete('subscriptionId');
        merged.delete('resourceGroupId');
        return merged;
      },
      { replace: true },
    );
  }, [tenantId, setParams]);

  const relSet = new Set(rel ? rel.split(',') : RELATIONSHIP_TYPES);
  const toggleRel = (t: string) => {
    const next = new Set(relSet);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    update({ rel: next.size === RELATIONSHIP_TYPES.length || next.size === 0 ? undefined : [...next].join(',') });
  };

  const selected = graphData?.nodes.find((n) => n.id === selectedId) ?? null;
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !graphData) return [];
    return graphData.nodes.filter((n) => n.name.toLowerCase().includes(q)).slice(0, 8);
  }, [query, graphData]);

  const option = useMemo(() => {
    if (view === 'map') return map.data ? mapOption(map.data, currency) : null;
    return graphData ? graphOption(graphData, selectedId, currency) : null;
  }, [view, map.data, graphData, selectedId]);

  function pick(id: string) {
    setSelectedId(id);
    setQuery('');
    const idx = graphData?.nodes.findIndex((n) => n.id === id) ?? -1;
    if (idx >= 0) {
      chart.current?.dispatchAction({ type: 'downplay', seriesIndex: 0 });
      chart.current?.dispatchAction({ type: 'highlight', seriesIndex: 0, dataIndex: idx });
    }
  }

  function zoom(factor: number) {
    const inst = chart.current;
    if (!inst) return;
    const series = (inst.getOption() as { series?: { zoom?: number }[] }).series?.[0];
    inst.setOption({ series: [{ zoom: Math.max(0.2, Math.min(8, (series?.zoom ?? 1) * factor)) }] });
  }

  function drill(clusterId: string) {
    const key = clusterId === '__none__' ? '' : clusterId;
    if (groupBy === 'resourceGroup') update({ view: 'graph', resourceGroupId: key || undefined });
    else if (groupBy === 'subscription') update({ view: 'graph', subscriptionId: key || undefined, resourceGroupId: undefined });
    else if (groupBy === 'category') update({ view: 'graph', category: key || undefined });
    else if (groupBy === 'type') update({ view: 'graph', type: key || undefined });
    else update({ view: 'graph', location: key || undefined });
  }

  const empty = view === 'map' ? map.data && map.data.clusters.length === 0 : graphData && graphData.nodes.length === 0;
  const truncated = view !== 'map' && graphData?.stats.truncated;

  return (
    <div>
      <PageHeader
        overline="Estate"
        title="Topology"
        subtitle="How your resources connect — network, identity, RBAC and managed-by edges discovered during sync. Start from the map, open a group, then focus on a resource to see what it depends on and what depends on it."
      />

      <Panel className="mb-3" bodyClassName="space-y-3 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            label="View"
            value={view}
            onChange={(v) => update({ view: v === 'focus' ? undefined : v, focus: v === 'focus' ? focus : undefined })}
            options={[
              { value: 'map', label: 'Map' },
              { value: 'graph', label: 'Resources' },
              ...(focus ? [{ value: 'focus' as View, label: 'Focus' }] : []),
            ]}
          />
          {view === 'map' && (
            <Select value={groupBy} onChange={(e) => update({ groupBy: e.target.value })} aria-label="Group by" selectClassName="max-w-[14rem]">
              {TOPOLOGY_CLUSTER_BY.map((g) => (
                <option key={g} value={g}>
                  By {CLUSTER_LABELS[g].toLowerCase()}
                </option>
              ))}
            </Select>
          )}
          {view !== 'focus' && (
            <>
              <Select
                icon={KeyRound}
                value={subscriptionId}
                onChange={(e) => update({ subscriptionId: e.target.value, resourceGroupId: undefined })}
                aria-label="Subscription scope"
                selectClassName="max-w-[14rem]"
              >
                <option value="">All subscriptions</option>
                {orgSubs.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
              <Select icon={FolderTree} value={resourceGroupId} onChange={(e) => update({ resourceGroupId: e.target.value })} aria-label="Resource group scope" selectClassName="max-w-[14rem]">
                <option value="">All resource groups</option>
                {rgs.data?.map((rg) => (
                  <option key={rg.id} value={rg.id}>
                    {rg.name}
                  </option>
                ))}
              </Select>
              {view === 'graph' && (
                <Select icon={Boxes} value={type} onChange={(e) => update({ type: e.target.value })} aria-label="Resource type" selectClassName="max-w-[14rem]">
                  <option value="">All types</option>
                  {(graph.data?.types ?? (type ? [type] : [])).map((t) => (
                    <option key={t} value={t}>
                      {shortType(t)}
                    </option>
                  ))}
                </Select>
              )}
            </>
          )}
          {view === 'focus' && (
            <>
              <SegmentedControl
                label="Depth"
                value={String(depth) as '1' | '2' | '3'}
                onChange={(v) => update({ depth: v === '1' ? undefined : v })}
                options={[
                  { value: '1', label: '1 hop' },
                  { value: '2', label: '2 hops' },
                  { value: '3', label: '3 hops' },
                ]}
              />
              <SegmentedControl
                label="Direction"
                value={direction}
                onChange={(v) => update({ dir: v === 'both' ? undefined : v })}
                options={[
                  { value: 'both', label: 'Both' },
                  { value: 'out', label: 'Dependencies' },
                  { value: 'in', label: 'Dependents' },
                ]}
              />
              <Button variant="ghost" icon={X} onClick={() => update({ focus: undefined, depth: undefined, dir: undefined })}>
                Exit focus
              </Button>
            </>
          )}
          {(hasScope || rel) && view !== 'focus' && (
            <Button variant="ghost" icon={RotateCcw} onClick={() => setParams(new URLSearchParams(view === 'map' ? {} : { view }), { replace: true })}>
              Reset
            </Button>
          )}
          {(category || location) && view === 'graph' && (
            <span className="flex flex-wrap gap-1.5">
              {category && <Badge tone="accent">category: {category}</Badge>}
              {location && <Badge tone="accent">region: {location}</Badge>}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {view !== 'map' && (
            <div className="relative w-full sm:w-72">
              <Input
                icon={Search}
                controlSize="sm"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && matches[0] && pick(matches[0].id)}
                placeholder="Find a resource in this view…"
                aria-label="Find a resource in the graph"
              />
              {matches.length > 0 && (
                <ul className="absolute left-0 right-0 top-full z-20 mt-1 animate-pop-in rounded-md border border-line-strong bg-overlay p-1 shadow-2">
                  {matches.map((n) => (
                    <li key={n.id}>
                      <button type="button" onClick={() => pick(n.id)} className="flex w-full items-center gap-2 rounded-xs px-2 py-1.5 text-left text-body-sm hover:bg-hover">
                        <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: CATEGORY_COLORS[n.category] }} aria-hidden />
                        <span className="min-w-0 flex-1 truncate text-fg">{n.name}</span>
                        <span className="shrink-0 text-caption text-fg-muted">{shortType(n.type)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div role="group" aria-label="Relationship types" className="flex flex-wrap items-center gap-1">
            {RELATIONSHIP_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={relSet.has(t)}
                onClick={() => toggleRel(t)}
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-xs border px-2 text-caption transition-colors duration-150',
                  relSet.has(t) ? 'border-line-strong bg-raised text-fg-secondary' : 'border-line text-fg-faint line-through',
                )}
              >
                <span className="h-0.5 w-3 rounded-full" style={{ backgroundColor: EDGE_COLORS[t] }} aria-hidden />
                {t}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-3 font-mono text-caption text-fg-muted">
            {active.isFetching && <Spinner />}
            {view === 'map' && map.data && (
              <span>
                <b className="font-medium text-fg">{map.data.stats.clusters}</b> groups · <b className="font-medium text-fg">{map.data.stats.resources}</b> resources ·{' '}
                <b className="font-medium text-fg">{map.data.stats.edges}</b> cross-group edges
              </span>
            )}
            {view !== 'map' && graphData && (
              <span>
                <b className="font-medium text-fg">{graphData.nodes.length}</b> nodes · <b className="font-medium text-fg">{graphData.edges.length}</b> edges
              </span>
            )}
          </div>
        </div>
      </Panel>

      {truncated && (
        <Alert tone="warning" className="mb-3" title={view === 'focus' ? `Stopped at ${graphData!.stats.limit} resources` : `Showing ${graphData!.stats.shown} of ${graphData!.stats.total} resources in scope`}>
          {view === 'focus' ? 'Reduce the depth or pick one direction.' : 'Use the Map to pick a group, or narrow the scope, to see everything.'}
        </Alert>
      )}

      {active.isLoading ? (
        <div className="rounded-md border border-line bg-surface p-5" role="status" aria-label="Loading topology">
          <Skeleton className="h-[420px] md:h-[600px]" />
        </div>
      ) : active.isError ? (
        <ErrorState title="Couldn’t load the topology" error={active.error} onRetry={() => void active.refetch()} retrying={active.isRefetching} />
      ) : empty ? (
        <EmptyState
          icon={Network}
          title="Nothing to show here"
          description={hasScope ? 'No resources match this scope — widen it.' : 'Run a sync to discover resources and their relationships.'}
        />
      ) : (
        <div className={cn('grid grid-cols-1 gap-3', selected && 'xl:grid-cols-[minmax(0,1fr)_20rem]')}>
          <Panel flush>
            {view !== 'map' && graphData && graphData.edges.length === 0 && (
              <Alert tone="info" className="m-3 mb-0">
                No dependency edges{rel ? ' of the selected types' : ''} in this view. Edges come from resource configuration on sync — VMs, NICs, subnets, NSGs,
                disks and managed identities produce the richest graphs.
              </Alert>
            )}
            <div className="relative h-[460px] md:h-[640px]">
              <ReactECharts
                key={`${view}-${fitKey}`}
                option={option ?? {}}
                notMerge
                style={{ height: '100%' }}
                onChartReady={(inst: ChartInstance) => {
                  chart.current = inst;
                }}
                onEvents={{
                  click: (p: NodeParam) => {
                    if (p.dataType !== 'node' || !p.data?.id) return;
                    if (view === 'map') drill(p.data.id);
                    else setSelectedId(p.data.id);
                  },
                  dblclick: (p: NodeParam) => {
                    if (view !== 'map' && p.dataType === 'node' && p.data?.id) update({ focus: p.data.id });
                  },
                }}
              />
              <div className="absolute bottom-3 right-3 flex flex-col gap-1 rounded-sm border border-line bg-surface/90 p-1 shadow-1">
                <IconButton icon={Plus} label="Zoom in" size="sm" tooltipSide="right" onClick={() => zoom(1.3)} />
                <IconButton icon={Minus} label="Zoom out" size="sm" tooltipSide="right" onClick={() => zoom(1 / 1.3)} />
                <IconButton icon={Maximize2} label="Fit / reset view" size="sm" tooltipSide="right" onClick={() => setFitKey((k) => k + 1)} />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line-subtle px-4 py-3 text-caption text-fg-muted md:px-5">
              {view === 'map' ? (
                <>
                  <span>Size = resources · colour = main service category</span>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block size-3 rounded-full border-2 border-danger" /> has high-severity findings
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block size-3 rounded-full border border-dashed border-fg-muted opacity-60" /> outside scope
                  </span>
                </>
              ) : (
                <>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block size-3 rounded-full border-2 border-danger" /> high-severity findings
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block size-3 rounded-full border border-dashed border-fg-muted opacity-60" /> outside scope
                  </span>
                </>
              )}
              <span className="ml-auto hidden items-center gap-1.5 lg:flex">
                <MousePointerClick className="size-3.5" aria-hidden />
                {view === 'map' ? 'Click a group to open it · scroll to zoom · drag to move' : 'Click to inspect · double-click to focus · scroll to zoom'}
              </span>
            </div>
          </Panel>
          {selected && graphData && (
            <NodePanel
              node={selected}
              data={graphData}
              currency={currency}
              onClose={() => setSelectedId(null)}
              onSelect={pick}
              onFocus={(id, dir) => update({ focus: id, dir: dir === 'both' ? undefined : dir })}
            />
          )}
        </div>
      )}
    </div>
  );
}
