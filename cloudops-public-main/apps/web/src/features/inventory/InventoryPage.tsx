import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Bookmark,
  Boxes,
  ChevronDown,
  ChevronRight,
  Download,
  ListChecks,
  Plus,
  Save,
  SquareKanban,
  Tags,
  UserRound,
  Wrench,
  X,
  Search,
  SearchX,
  ShieldAlert,
  Tag,
  Trash2,
} from 'lucide-react';
import {
  INVENTORY_GROUP_BY,
  TOPOLOGY_CATEGORIES,
  type InventoryGroupBy,
  type InventoryGroupDto,
  type InventorySort,
  type ResourceDto,
  type TopologyCategory,
} from '@cloudops/core';
import {
  useCreateSavedView,
  useDeleteSavedView,
  useEvaluateResources,
  useFacets,
  useInventoryGroups,
  useInventoryTree,
  useResources,
  useSavedViews,
  type ResourceQueryParams,
} from '../../lib/queries';
import { useOrg } from '../../lib/orgContext';
import { money, shortType } from '../../lib/format';
import { CATEGORY_COLORS } from '../../lib/categories';
import { apiErrorMessage, downloadFile } from '../../lib/api';
import { usePermissions } from '../../lib/auth';
import { useCreateWork } from '../work/CreateWork';
import {
  Badge,
  Button,
  Chip,
  EmptyState,
  ErrorState,
  IconButton,
  Input,
  PageHeader,
  Pagination,
  Panel,
  SegmentedControl,
  Select,
  Spinner,
  TableSkeleton,
  TextButton,
  cn,
  severityTone,
  Menu,
} from '../../components/ui/primitives';
import { MultiSelect } from '../../components/ui/MultiSelect';
import { useConfirm, usePrompt } from '../../components/ui/Dialogs';
import { useToast } from '../../components/ui/Toast';
import { lifecycleTone } from './lifecycle';
import { ScopeTree, type ScopeSelection } from './ScopeTree';

// ── URL-backed state ────────────────────────────────────────────────
// Every filter lives in the URL: shareable links, working back button, and a
// deep link survives sign-in.

const LIST_KEYS = ['types', 'locations', 'subscriptionIds', 'owners', 'lifecycleStages', 'tags', 'categories'] as const;
type ListKey = (typeof LIST_KEYS)[number];
type StateView = 'active' | 'deleted' | 'all';

interface Filters extends Record<ListKey, string[]> {
  search: string;
}
const EMPTY: Filters = { search: '', types: [], locations: [], subscriptionIds: [], owners: [], lifecycleStages: [], tags: [], categories: [] };
const PAGE_SIZE = 25;

const GROUP_LABELS: Record<InventoryGroupBy, string> = {
  organization: 'Organization',
  subscription: 'Subscription',
  resourceGroup: 'Resource group',
  category: 'Category',
  type: 'Type',
  location: 'Region',
  owner: 'Owner',
};
const UNASSIGNED = '__unassigned__';

function useInventoryUrl() {
  const [params, setParams] = useSearchParams();
  const list = (k: string) => (params.get(k) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const filters: Filters = { search: params.get('q') ?? '', ...(Object.fromEntries(LIST_KEYS.map((k) => [k, list(k)])) as Record<ListKey, string[]>) };
  const state = (params.get('state') as StateView | null) ?? 'active';
  const groupBy = (INVENTORY_GROUP_BY as readonly string[]).includes(params.get('groupBy') ?? '') ? (params.get('groupBy') as InventoryGroupBy) : null;
  const sort = (params.get('sort') as InventorySort | null) ?? 'name';
  const dir = params.get('dir') === 'desc' ? 'desc' : 'asc';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const resourceGroupId = params.get('resourceGroupId') ?? '';

  function update(patch: Record<string, string | string[] | number | null | undefined>, { keepPage = false } = {}) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      const value = Array.isArray(v) ? v.join(',') : v == null ? '' : String(v);
      if (value === '' || (k === 'state' && value === 'active') || (k === 'sort' && value === 'name') || (k === 'dir' && value === 'asc')) next.delete(k);
      else next.set(k, value);
    }
    if (!keepPage && !('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  }
  return { params, filters, state, groupBy, sort, dir, page, resourceGroupId, update } as const;
}

// ── Small pieces ────────────────────────────────────────────────────

function CategoryDot({ category }: { category?: string }) {
  const color = CATEGORY_COLORS[(category as TopologyCategory) ?? 'Other'] ?? CATEGORY_COLORS.Other;
  return <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{ background: color }} title={category} aria-hidden />;
}

/** "Org › Subscription › Resource group" for a row, the RG part scoping the view to it. */
function WhereLine({ r, onScope }: { r: ResourceDto; onScope: (s: ScopeSelection) => void }) {
  const parts = [r.organizationName, r.subscriptionName].filter(Boolean) as string[];
  return (
    <div className="mt-0.5 flex min-w-0 items-center gap-1 text-caption text-fg-muted">
      <span className="truncate">{parts.join(' › ')}</span>
      {r.resourceGroupName && (
        <>
          {parts.length > 0 && <span aria-hidden>›</span>}
          <button
            type="button"
            className="truncate rounded-xs text-fg-secondary underline-offset-2 hover:text-accent hover:underline"
            title={`Show everything in ${r.resourceGroupName}`}
            onClick={(e) => {
              e.stopPropagation();
              onScope({ tenantId: r.organizationId ?? '', subscriptionId: r.subscriptionId ?? '', resourceGroupId: r.resourceGroupId ?? '' });
            }}
          >
            {r.resourceGroupName}
          </button>
        </>
      )}
    </div>
  );
}

function Issues({ r, linked = true }: { r: ResourceDto; linked?: boolean }) {
  if (!r.failingChecks) return <span className="text-caption text-fg-faint">—</span>;
  const badge = (
    <Badge tone={severityTone(r.worstSeverity ?? 'low')}>
      <ShieldAlert className="-ml-0.5 mr-0.5 inline size-3" aria-hidden />
      {r.failingChecks}
    </Badge>
  );
  // Inside a row that is itself a link (phone layout), a nested link is invalid — show the badge only.
  if (!linked) return <span title={`${r.failingChecks} failing check(s) — worst: ${r.worstSeverity}`}>{badge}</span>;
  return (
    <Link to={`/inventory/${r.id}?tab=Compliance`} onClick={(e) => e.stopPropagation()} title={`${r.failingChecks} failing check(s) — worst: ${r.worstSeverity}`}>
      {badge}
    </Link>
  );
}

const COLUMNS: { key: string; label: string; sort?: InventorySort; className?: string; numeric?: boolean }[] = [
  { key: 'name', label: 'Resource', sort: 'name' },
  { key: 'type', label: 'Type', sort: 'type', className: 'hidden xl:table-cell' },
  { key: 'location', label: 'Region', sort: 'location', className: 'hidden 2xl:table-cell' },
  { key: 'owner', label: 'Owner', className: 'hidden min-[1800px]:table-cell' },
  { key: 'cost', label: 'Cost (30d)', sort: 'cost', numeric: true },
  { key: 'issues', label: 'Issues', className: 'hidden sm:table-cell' },
  { key: 'lifecycle', label: 'Lifecycle', className: 'hidden 2xl:table-cell' },
];

function ResourceTable({
  items,
  sort,
  dir,
  onSort,
  onScope,
  selected,
  onToggle,
  onToggleAll,
}: {
  items: ResourceDto[];
  sort?: InventorySort;
  dir?: 'asc' | 'desc';
  onSort?: (s: InventorySort) => void;
  onScope: (s: ScopeSelection) => void;
  /** Row selection for bulk actions (omit to hide the checkboxes). */
  selected?: Set<string>;
  onToggle?: (id: string) => void;
  onToggleAll?: (ids: string[], on: boolean) => void;
}) {
  const navigate = useNavigate();
  const selectable = Boolean(selected && onToggle);
  const allOn = selectable && items.length > 0 && items.every((r) => selected!.has(r.id));
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="data-table">
          <thead>
            <tr>
              {selectable && (
                <th scope="col" className="w-8">
                  <input
                    type="checkbox"
                    className="size-3.5 cursor-pointer"
                    aria-label="Select all on this page"
                    checked={allOn}
                    onChange={() => onToggleAll?.(items.map((r) => r.id), !allOn)}
                  />
                </th>
              )}
              {COLUMNS.map((c) => (
                <th key={c.key} scope="col" className={cn(c.numeric && 'num', c.className)} aria-sort={c.sort && sort === c.sort ? (dir === 'desc' ? 'descending' : 'ascending') : undefined}>
                  {c.sort && onSort ? (
                    <button type="button" onClick={() => onSort(c.sort!)} className={cn('inline-flex items-center gap-1 rounded-xs hover:text-fg', sort === c.sort && 'text-fg')}>
                      {c.label}
                      {sort === c.sort ? dir === 'desc' ? <ArrowDown className="size-3" aria-hidden /> : <ArrowUp className="size-3" aria-hidden /> : <ArrowUpDown className="size-3 opacity-40" aria-hidden />}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id} data-interactive data-expanded={selected?.has(r.id) || undefined} onClick={() => navigate(`/inventory/${r.id}`)}>
                {selectable && (
                  <td className="w-8" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      className="size-3.5 cursor-pointer"
                      aria-label={`Select ${r.name}`}
                      checked={selected!.has(r.id)}
                      onChange={() => onToggle!(r.id)}
                    />
                  </td>
                )}
                <td className="max-w-[26rem]">
                  <div className="flex min-w-0 gap-2">
                    <CategoryDot category={r.category} />
                    <div className="min-w-0">
                      <Link to={`/inventory/${r.id}`} onClick={(e) => e.stopPropagation()} className="link-quiet font-medium [overflow-wrap:anywhere]">
                        {r.name}
                      </Link>
                      <WhereLine r={r} onScope={onScope} />
                      <span className="mt-0.5 block truncate text-caption text-fg-faint xl:hidden">{shortType(r.type)}</span>
                    </div>
                  </div>
                </td>
                <td className="hidden xl:table-cell">
                  <span className="block max-w-[15rem] truncate text-fg-muted" title={r.type}>
                    {shortType(r.type)}
                  </span>
                  <span className="text-caption text-fg-faint">
                    {r.category}
                    <span className="2xl:hidden">{r.location ? ` · ${r.location}` : ''}</span>
                  </span>
                </td>
                <td className="hidden whitespace-nowrap 2xl:table-cell">
                  <span className="font-mono text-caption">{r.location ?? '—'}</span>
                </td>
                <td className="hidden min-[1800px]:table-cell">{r.owner ?? <span className="italic text-fg-faint">unassigned</span>}</td>
                <td className="num whitespace-nowrap" title={r.dailyCost != null ? `${money(r.dailyCost, r.costCurrency)}/day (7-day avg)` : undefined}>
                  {r.costMonthly != null ? money(r.costMonthly, r.costCurrency) : <span className="text-fg-faint">—</span>}
                </td>
                <td className="hidden sm:table-cell">
                  <Issues r={r} />
                </td>
                <td className="hidden 2xl:table-cell">
                  <Badge tone={lifecycleTone(r.lifecycleStage)} dot>
                    {r.lifecycleStage ?? 'Created'}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Phone: stacked rows */}
      <ul className="divide-y divide-line-subtle md:hidden">
        {items.map((r) => (
          <li key={r.id}>
            <Link to={`/inventory/${r.id}`} className="focus-inset block px-4 py-3 transition-colors duration-150 active:bg-hover">
              <div className="flex items-start justify-between gap-3">
                <span className="flex min-w-0 gap-2">
                  <CategoryDot category={r.category} />
                  <span className="min-w-0 truncate font-medium text-fg">{r.name}</span>
                </span>
                <Issues r={r} linked={false} />
              </div>
              <div className="mt-0.5 truncate pl-4 text-caption text-fg-muted">
                {[r.subscriptionName, r.resourceGroupName].filter(Boolean).join(' › ')}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 pl-4 font-mono text-caption text-fg-secondary">
                <span className="font-sans">{shortType(r.type)}</span>
                <span>{r.location ?? '—'}</span>
                <span>{r.costMonthly != null ? `${money(r.costMonthly, r.costCurrency)}/mo` : '—'}</span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

/** One group, expandable; its resources load on demand. */
function GroupSection({ group, base, currency, onScope }: { group: InventoryGroupDto; base: ResourceQueryParams; currency: string; onScope: (s: ScopeSelection) => void }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const query = useMemo(() => ({ ...base, ...group.filter, page, pageSize: 50 }), [base, group.filter, page]);
  const members = useResources(query, open);
  const data = members.data;
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="focus-inset flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-150 hover:bg-hover md:px-5"
      >
        {open ? <ChevronDown className="size-4 shrink-0 text-fg-muted" aria-hidden /> : <ChevronRight className="size-4 shrink-0 text-fg-muted" aria-hidden />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-body-sm font-medium text-fg">{group.label}</div>
          {group.context && <div className="truncate text-caption text-fg-muted">{group.context}</div>}
        </div>
        <span className="shrink-0 font-mono text-caption tabular-nums text-fg-muted">{group.count}</span>
        <span className="w-24 shrink-0 text-right font-mono text-caption tabular-nums text-fg-secondary">{group.costMonthly > 0 ? `${money(group.costMonthly, currency)}/mo` : '—'}</span>
      </button>
      {open && (
        <div className="border-y border-line-subtle bg-canvas/40">
          {members.isLoading || !data ? (
            <TableSkeleton rows={Math.min(group.count, 5)} cols={5} />
          ) : (
            <>
              <ResourceTable items={data.items} onScope={onScope} />
              {data.totalPages > 1 && (
                <div className="flex items-center justify-end gap-2 px-4 py-2 text-caption text-fg-muted">
                  Page {data.page} of {data.totalPages}
                  <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                    Previous
                  </Button>
                  <Button variant="ghost" size="sm" disabled={page >= data.totalPages} onClick={() => setPage((p) => p + 1)}>
                    Next
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}

// ── Page ────────────────────────────────────────────────────────────

/** CSV of the selected rows (the page's own data — no extra request). */
function selectedCsv(rows: ResourceDto[]): string {
  const cell = (v: unknown) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['name', 'type', 'location', 'subscription', 'resourceGroup', 'owner', 'monthlyCost', 'failingChecks', 'resourceId'];
  const lines = rows.map((r) =>
    [r.name, r.type, r.location, r.subscriptionName, r.resourceGroupName, r.owner, r.costMonthly, r.failingChecks, r.externalId].map(cell).join(','),
  );
  return `\uFEFF${[head.join(','), ...lines].join('\r\n')}`;
}

/**
 * Bulk actions on the selected resources — or on everything matching the
 * filters. Changes to the cloud go through remediation (preview, approval when
 * risky, verification, audit); nothing is changed silently from here.
 */
function BulkBar({
  count,
  total,
  allMatching,
  onAllMatching,
  onClear,
  rows,
  filterString,
}: {
  count: number;
  total: number;
  allMatching: boolean;
  onAllMatching: () => void;
  onClear: () => void;
  rows: ResourceDto[];
  filterString: string;
}) {
  const { can } = usePermissions();
  const createWork = useCreateWork();
  const evaluate = useEvaluateResources();
  const toast = useToast();
  const n = allMatching ? Math.min(total, 500) : count;
  const target = allMatching ? `filter=${encodeURIComponent(filterString)}` : `resources=${rows.map((r) => r.id).join(',')}`;
  const change = (action: string) => `/remediation/new?action=${action}&${target}`;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-accent/30 bg-accent/[0.06] px-4 py-2.5 md:px-5">
      <span className="text-body-sm font-medium text-fg">
        {allMatching ? `All ${total > 500 ? '500 (of ' + total + ')' : total} matching` : `${count} selected`}
      </span>
      {!allMatching && total > count && (
        <TextButton onClick={onAllMatching}>Select all {Math.min(total, 500)} matching the filters</TextButton>
      )}
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <Menu
          label={`Act on ${n}`}
          icon={Wrench}
          size="sm"
          variant="primary"
          sections={[
            {
              label: 'Change in the cloud (previewed first)',
              items: [
                { key: 'owner', label: 'Assign an owner…', icon: UserRound, to: change('tags.assign-owner'), disabled: !can('remediation.request') },
                { key: 'env', label: 'Set the environment tag…', icon: Tags, to: change('tags.set-environment'), disabled: !can('remediation.request') },
                { key: 'tag', label: 'Add a tag…', icon: Tag, to: change('tags.add'), disabled: !can('remediation.request') },
                { key: 'other', label: 'Other remediation…', icon: Wrench, to: `/remediation/new?${target}`, disabled: !can('remediation.request') },
              ],
            },
            {
              label: 'Track and check',
              items: [
                {
                  key: 'work',
                  label: 'Create a work item',
                  icon: SquareKanban,
                  disabled: !can('work.manage') || allMatching,
                  hint: allMatching ? 'Select specific resources to link them' : undefined,
                  onSelect: () =>
                    createWork({ scopes: rows.slice(0, 50).map((r) => ({ scopeType: 'resource' as const, scopeId: r.id, scopeName: r.name })) }),
                },
                {
                  key: 'evaluate',
                  label: 'Re-evaluate compliance',
                  icon: ListChecks,
                  disabled: !(can('standards.evaluate') || can('resource.operate')) || allMatching,
                  hint: allMatching ? 'Use Standards → Run evaluation for everything' : undefined,
                  onSelect: () =>
                    evaluate.mutate(
                      rows.map((r) => r.id),
                      {
                        onSuccess: (d) => toast({ title: 'Re-evaluated', description: `${d.evaluated} resource(s).` }),
                        onError: (e) => toast({ tone: 'danger', title: 'Re-evaluation failed', description: apiErrorMessage(e) }),
                      },
                    ),
                },
                {
                  key: 'csv',
                  label: 'Export selected (CSV)',
                  icon: Download,
                  disabled: allMatching,
                  hint: allMatching ? 'Use Export CSV for everything matching' : undefined,
                  onSelect: () => {
                    const url = URL.createObjectURL(new Blob([selectedCsv(rows)], { type: 'text/csv;charset=utf-8' }));
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `cloudops-selected-${new Date().toISOString().slice(0, 10)}.csv`;
                    a.click();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                  },
                },
              ],
            },
          ]}
        />
        <IconButton icon={X} label="Clear selection" size="sm" onClick={onClear} />
      </div>
    </div>
  );
}

export function InventoryPage() {
  const confirm = useConfirm();
  const prompt = usePrompt();
  const toast = useToast();
  const url = useInventoryUrl();
  const { filters: f, state, groupBy, sort, dir, page, resourceGroupId } = url;
  const { tenantId, setTenantId } = useOrg();

  const [tagKey, setTagKey] = useState('');
  const [tagValue, setTagValue] = useState('');
  const [viewId, setViewId] = useState('');
  const [exporting, setExporting] = useState(false);
  const [search, setSearch] = useState(f.search);

  const facets = useFacets();
  const views = useSavedViews('inventory');
  const createView = useCreateSavedView();
  const deleteView = useDeleteSavedView();
  const tree = useInventoryTree(state === 'all' ? 'active,deleted' : state);

  // Deep links from elsewhere (?tenantId=, ?subscriptionId=) seed the scope once.
  const urlTenant = url.params.get('tenantId');
  const urlSub = url.params.get('subscriptionId');
  useEffect(() => {
    if (!urlTenant && !urlSub) return;
    if (urlTenant && urlTenant !== tenantId) setTenantId(urlTenant);
    url.update({ tenantId: null, subscriptionId: null, ...(urlSub ? { subscriptionIds: [urlSub], resourceGroupId: null } : {}) });
    // Runs only when a deep link arrives; `url`/`tenantId` changing must not re-trigger it.
  }, [urlTenant, urlSub]);

  // Debounce the search box into the URL.
  useEffect(() => setSearch(f.search), [f.search]);
  useEffect(() => {
    const t = setTimeout(() => search !== f.search && url.update({ q: search }), 300);
    return () => clearTimeout(t);
    // Keyed on the input only — the URL write is the effect, not a dependency.
  }, [search]);

  // Scope (tree / breadcrumb) = org (global) + one subscription + one resource group.
  const scopeSub = f.subscriptionIds.length === 1 ? f.subscriptionIds[0]! : '';
  const selection: ScopeSelection = { tenantId, subscriptionId: scopeSub, resourceGroupId };
  function scopeTo(next: ScopeSelection) {
    if (next.tenantId !== tenantId) setTenantId(next.tenantId);
    url.update({ subscriptionIds: next.subscriptionId ? [next.subscriptionId] : [], resourceGroupId: next.resourceGroupId || null });
  }

  const baseQuery = useMemo(() => {
    const q: ResourceQueryParams = {
      search: f.search || undefined,
      tenantId: tenantId || undefined,
      resourceGroupId: resourceGroupId || undefined,
      states: state === 'all' ? undefined : state,
    };
    for (const k of LIST_KEYS) if (f[k].length) q[k] = f[k].join(',');
    return q;
  }, [f, tenantId, resourceGroupId, state]);

  const listQuery = useMemo(() => ({ ...baseQuery, sort, dir, page, pageSize: PAGE_SIZE }), [baseQuery, sort, dir, page]);
  const list = useResources(listQuery, !groupBy);

  // Selection for bulk actions — cleared whenever the filters change.
  const [selected, setSelected] = useState<Map<string, ResourceDto>>(new Map());
  const [allMatching, setAllMatching] = useState(false);
  const filterString = useMemo(
    () => new URLSearchParams(Object.entries(baseQuery).filter((e): e is [string, string] => e[1] != null && e[1] !== '').map(([k, v]) => [k, String(v)])).toString(),
    [baseQuery],
  );
  useEffect(() => {
    setSelected(new Map());
    setAllMatching(false);
  }, [filterString]);
  const toggle = (id: string) =>
    setSelected((m) => {
      const next = new Map(m);
      const row = list.data?.items.find((r) => r.id === id);
      if (next.has(id)) next.delete(id);
      else if (row) next.set(id, row);
      setAllMatching(false);
      return next;
    });
  const toggleAll = (ids: string[], on: boolean) =>
    setSelected((m) => {
      const next = new Map(m);
      for (const id of ids) {
        const row = list.data?.items.find((r) => r.id === id);
        if (on && row) next.set(id, row);
        else next.delete(id);
      }
      setAllMatching(false);
      return next;
    });
  const groups = useInventoryGroups(baseQuery, groupBy);
  // Category tab counts ignore the category filter itself.
  const categoryQuery = useMemo(() => ({ ...baseQuery, categories: undefined }), [baseQuery]);
  const categoryCounts = useInventoryGroups(categoryQuery, 'category');

  const activeCount = (f.search ? 1 : 0) + LIST_KEYS.reduce((n, k) => n + (k === 'subscriptionIds' && scopeSub ? 0 : f[k].length), 0);
  const subName = (id: string) => facets.data?.subscriptions.find((s) => s.id === id)?.name ?? 'subscription';

  // Breadcrumb names from the tree.
  const crumbs = useMemo(() => {
    const out: { label: string; select: ScopeSelection }[] = [];
    for (const o of tree.data?.organizations ?? []) {
      const sub = o.subscriptions.find((s) => s.id === scopeSub || s.resourceGroups.some((g) => g.id === resourceGroupId));
      if (o.id && o.id === tenantId && !sub) out.push({ label: o.name, select: { tenantId: o.id, subscriptionId: '', resourceGroupId: '' } });
      if (sub) {
        out.push({ label: o.name, select: { tenantId: o.id ?? '', subscriptionId: '', resourceGroupId: '' } });
        out.push({ label: sub.name, select: { tenantId: o.id ?? '', subscriptionId: sub.id, resourceGroupId: '' } });
        const rg = sub.resourceGroups.find((g) => g.id === resourceGroupId);
        if (rg) out.push({ label: rg.name, select: { tenantId: o.id ?? '', subscriptionId: sub.id, resourceGroupId: rg.id } });
      }
    }
    return out;
  }, [tree.data, tenantId, scopeSub, resourceGroupId]);

  async function exportCsv() {
    setExporting(true);
    try {
      await downloadFile('/api/inventory/resources/export.csv', { ...baseQuery, sort, dir }, 'cloudops-inventory.csv');
    } catch (err) {
      toast({ tone: 'danger', title: 'Export failed', description: apiErrorMessage(err) });
    } finally {
      setExporting(false);
    }
  }

  function addTag() {
    const key = tagKey.trim();
    const value = tagValue.trim();
    if (!key || !value) return;
    const entry = `${key}:${value}`;
    if (!f.tags.includes(entry)) url.update({ tags: [...f.tags, entry] });
    setTagValue('');
  }

  async function saveView() {
    const name = await prompt({
      title: 'Save view',
      description: 'Saves the current search, filters and scope so you can reapply them in one click.',
      label: 'View name',
      placeholder: 'e.g. Untagged production VMs',
      confirmLabel: 'Save view',
    });
    if (!name?.trim()) return;
    const created = await createView.mutateAsync({
      name: name.trim(),
      scope: 'inventory',
      filters: { ...f, resourceGroupId, groupBy } as unknown as Record<string, unknown>,
    });
    setViewId(created.id);
    toast({ title: 'View saved', description: `“${name.trim()}” is now in your saved views.` });
  }

  function loadView(id: string) {
    setViewId(id);
    const view = views.data?.find((v) => v.id === id);
    if (!view) return;
    const v = { ...EMPTY, ...(view.filters as Partial<Filters> & { resourceGroupId?: string; groupBy?: string }) };
    url.update({
      q: v.search,
      ...Object.fromEntries(LIST_KEYS.map((k) => [k, v[k] ?? []])),
      resourceGroupId: (view.filters as { resourceGroupId?: string }).resourceGroupId ?? null,
      groupBy: (view.filters as { groupBy?: string }).groupBy ?? null,
    });
  }

  async function removeView() {
    if (!viewId) return;
    const name = views.data?.find((v) => v.id === viewId)?.name;
    const ok = await confirm({
      title: 'Delete saved view?',
      description: `${name ? `“${name}”` : 'This view'} will be deleted. Your current filters stay applied.`,
      confirmLabel: 'Delete view',
      tone: 'danger',
    });
    if (!ok) return;
    await deleteView.mutateAsync(viewId);
    setViewId('');
    toast({ title: 'Saved view deleted' });
  }

  function clearAll() {
    url.update({ q: null, ...Object.fromEntries(LIST_KEYS.filter((k) => !(k === 'subscriptionIds' && scopeSub)).map((k) => [k, []])) });
    setViewId('');
  }

  const total = groupBy ? groups.data?.total : list.data?.total;
  const categories = (categoryCounts.data?.groups ?? []).filter((g) => g.count > 0);
  const byCategory = new Map(categories.map((g) => [g.key, g.count]));
  const categoryTotal = categories.reduce((n, g) => n + g.count, 0);
  const loading = groupBy ? groups.isLoading : list.isLoading;
  const fetching = groupBy ? groups.isFetching : list.isFetching;

  return (
    <div>
      <PageHeader
        overline="Estate"
        title="Inventory"
        subtitle="Every discovered resource — browse by organization, subscription and resource group, slice by category, and group or sort any way you need."
        actions={
          <>
            <Select icon={Bookmark} value={viewId} onChange={(e) => loadView(e.target.value)} aria-label="Saved views" selectClassName="max-w-[15rem]">
              <option value="">Saved views…</option>
              {views.data?.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
            {viewId && <IconButton icon={Trash2} label="Delete saved view" variant="danger-ghost" onClick={() => void removeView()} loading={deleteView.isPending} />}
            <Button variant="secondary" icon={Save} onClick={() => void saveView()} loading={createView.isPending}>
              Save view
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-4 lg:self-start">
          <ScopeTree tree={tree.data} loading={tree.isLoading} selection={selection} onSelect={scopeTo} />
        </aside>

        <div className="min-w-0 space-y-3">
          {/* Where am I */}
          <nav aria-label="Current scope" className="flex flex-wrap items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-2 text-body-sm">
            <button type="button" className="rounded-xs text-fg-muted hover:text-fg" onClick={() => scopeTo({ tenantId: '', subscriptionId: '', resourceGroupId: '' })}>
              All organizations
            </button>
            {crumbs.map((c, i) => (
              <span key={i} className="inline-flex items-center gap-1.5">
                <ChevronRight className="size-3.5 text-fg-faint" aria-hidden />
                <button
                  type="button"
                  onClick={() => scopeTo(c.select)}
                  className={cn('rounded-xs hover:text-fg', i === crumbs.length - 1 ? 'font-medium text-fg' : 'text-fg-muted')}
                  aria-current={i === crumbs.length - 1 ? 'location' : undefined}
                >
                  {c.label}
                </button>
              </span>
            ))}
            {f.subscriptionIds.length > 1 && <span className="text-fg-muted">· {f.subscriptionIds.length} subscriptions</span>}
            <span className="ml-auto font-mono text-caption tabular-nums text-fg-muted">{total ?? '…'} resources</span>
          </nav>

          {/* Category segmentation */}
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by category">
            <button
              type="button"
              aria-pressed={f.categories.length === 0}
              onClick={() => url.update({ categories: [] })}
              className={cn(
                'focus-ring inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-caption transition-colors duration-150',
                f.categories.length === 0 ? 'border-accent bg-accent/10 text-fg' : 'border-line text-fg-secondary hover:bg-hover',
              )}
            >
              All <span className="font-mono tabular-nums text-fg-muted">{categoryTotal}</span>
            </button>
            {TOPOLOGY_CATEGORIES.filter((c) => byCategory.has(c)).map((c) => {
              const on = f.categories.includes(c);
              return (
                <button
                  key={c}
                  type="button"
                  aria-pressed={on}
                  onClick={() => url.update({ categories: on ? f.categories.filter((x) => x !== c) : [...f.categories, c] })}
                  className={cn(
                    'focus-ring inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-caption transition-colors duration-150',
                    on ? 'border-accent bg-accent/10 text-fg' : 'border-line text-fg-secondary hover:bg-hover',
                  )}
                >
                  <span className="size-2 rounded-full" style={{ background: CATEGORY_COLORS[c] }} aria-hidden />
                  {c} <span className="font-mono tabular-nums text-fg-muted">{byCategory.get(c)}</span>
                </button>
              );
            })}
          </div>

          {/* Filters */}
          <Panel bodyClassName="space-y-3 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Input icon={Search} className="min-w-[min(100%,240px)] flex-1" placeholder="Search name, type, id or owner…" aria-label="Search resources" value={search} onChange={(e) => setSearch(e.target.value)} />
              <MultiSelect label="Type" options={(facets.data?.types ?? []).map((t) => ({ value: t, label: shortType(t) }))} selected={f.types} onChange={(v) => url.update({ types: v })} />
              <MultiSelect label="Region" options={(facets.data?.locations ?? []).map((l) => ({ value: l }))} selected={f.locations} onChange={(v) => url.update({ locations: v })} />
              <MultiSelect
                label="Subscription"
                options={(facets.data?.subscriptions ?? []).map((s) => ({ value: s.id, label: s.name }))}
                selected={f.subscriptionIds}
                onChange={(v) => url.update({ subscriptionIds: v, resourceGroupId: null })}
              />
              <MultiSelect
                label="Owner"
                options={[{ value: UNASSIGNED, label: 'Unassigned' }, ...(facets.data?.owners ?? []).map((o) => ({ value: o }))]}
                selected={f.owners}
                onChange={(v) => url.update({ owners: v })}
              />
              <MultiSelect label="Lifecycle" options={(facets.data?.lifecycleStages ?? []).map((l) => ({ value: l }))} selected={f.lifecycleStages} searchable={false} onChange={(v) => url.update({ lifecycleStages: v })} />
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-line-subtle pt-3">
              <span className="mr-1 inline-flex items-center gap-1.5 font-mono text-overline uppercase text-fg-muted">
                <Tag className="size-3.5" aria-hidden /> Tag
              </span>
              <Select value={tagKey} onChange={(e) => setTagKey(e.target.value)} aria-label="Tag key" selectClassName="max-w-[14rem]">
                <option value="">key…</option>
                {facets.data?.tagKeys.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </Select>
              <span className="hidden font-mono text-fg-faint sm:inline" aria-hidden>
                =
              </span>
              <Input value={tagValue} onChange={(e) => setTagValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addTag()} placeholder="value" aria-label="Tag value" className="w-40 sm:w-48" />
              <Button variant="secondary" icon={Plus} onClick={addTag} disabled={!tagKey || !tagValue.trim()}>
                Add tag filter
              </Button>
            </div>
          </Panel>

          {activeCount > 0 && (
            <div className="flex flex-wrap items-center gap-2" aria-label="Active filters">
              {f.search && <Chip label={`search: ${f.search}`} onRemove={() => url.update({ q: null })} />}
              {f.categories.map((c) => (
                <Chip key={`c-${c}`} label={c} onRemove={() => url.update({ categories: f.categories.filter((x) => x !== c) })} />
              ))}
              {f.types.map((t) => (
                <Chip key={`t-${t}`} label={shortType(t)} onRemove={() => url.update({ types: f.types.filter((x) => x !== t) })} />
              ))}
              {f.locations.map((l) => (
                <Chip key={`l-${l}`} label={l} onRemove={() => url.update({ locations: f.locations.filter((x) => x !== l) })} />
              ))}
              {!scopeSub &&
                f.subscriptionIds.map((s) => <Chip key={`s-${s}`} label={subName(s)} onRemove={() => url.update({ subscriptionIds: f.subscriptionIds.filter((x) => x !== s) })} />)}
              {f.owners.map((o) => (
                <Chip key={`o-${o}`} label={`owner: ${o === UNASSIGNED ? 'unassigned' : o}`} onRemove={() => url.update({ owners: f.owners.filter((x) => x !== o) })} />
              ))}
              {f.lifecycleStages.map((l) => (
                <Chip key={`lc-${l}`} label={l} onRemove={() => url.update({ lifecycleStages: f.lifecycleStages.filter((x) => x !== l) })} />
              ))}
              {f.tags.map((t) => (
                <Chip key={`tag-${t}`} label={`tag ${t}`} onRemove={() => url.update({ tags: f.tags.filter((x) => x !== t) })} />
              ))}
              <TextButton tone="muted" onClick={clearAll} className="ml-1">
                Clear filters
              </TextButton>
            </div>
          )}

          <Panel
            flush
            title={
              <span className="flex items-center gap-2">
                {groupBy ? `Grouped by ${GROUP_LABELS[groupBy].toLowerCase()}` : 'Resources'}
                {total != null && <span className="font-mono text-body-sm font-normal tabular-nums text-fg-muted">{groupBy ? `${groups.data?.groups.length ?? 0} groups · ${total}` : total}</span>}
              </span>
            }
            actions={
              <>
                {fetching && !loading && <Spinner label="Updating…" />}
                <Select value={groupBy ?? ''} onChange={(e) => url.update({ groupBy: e.target.value || null })} aria-label="Group by" selectClassName="max-w-[12rem]">
                  <option value="">No grouping</option>
                  {INVENTORY_GROUP_BY.map((g) => (
                    <option key={g} value={g}>
                      Group: {GROUP_LABELS[g]}
                    </option>
                  ))}
                </Select>
                <SegmentedControl
                  label="Resource state"
                  size="sm"
                  options={[
                    { value: 'active', label: 'Active' },
                    { value: 'deleted', label: 'Deleted' },
                    { value: 'all', label: 'All' },
                  ]}
                  value={state}
                  onChange={(v) => url.update({ state: v })}
                />
                <Button variant="secondary" size="sm" icon={Download} onClick={() => void exportCsv()} loading={exporting} disabled={!total} title="Download every resource matching the current filters (up to 50,000)">
                  Export CSV
                </Button>
              </>
            }
            footer={
              !groupBy && list.data && list.data.items.length > 0 ? (
                <Pagination
                  page={list.data.page}
                  totalPages={list.data.totalPages}
                  total={list.data.total}
                  pageSize={PAGE_SIZE}
                  noun="resources"
                  onPrev={() => url.update({ page: Math.max(1, page - 1) }, { keepPage: true })}
                  onNext={() => url.update({ page: page + 1 }, { keepPage: true })}
                />
              ) : undefined
            }
          >
            {loading ? (
              <TableSkeleton rows={10} cols={6} />
            ) : (groupBy ? groups.isError : list.isError) ? (
              <ErrorState compact title="Couldn’t load resources" error={groupBy ? groups.error : list.error} onRetry={() => void (groupBy ? groups.refetch() : list.refetch())} />
            ) : total ? (
              <div className={cn('transition-opacity duration-150', fetching && 'opacity-70')}>
                {groupBy ? (
                  <ul className="divide-y divide-line-subtle">
                    {groups.data!.groups.map((g) => (
                      <GroupSection key={`${groupBy}:${g.key}`} group={g} base={baseQuery} currency={groups.data!.costCurrency} onScope={scopeTo} />
                    ))}
                  </ul>
                ) : (
                  <>
                    {(selected.size > 0 || allMatching) && (
                      <BulkBar
                        count={selected.size}
                        total={list.data!.total}
                        allMatching={allMatching}
                        onAllMatching={() => setAllMatching(true)}
                        onClear={() => {
                          setSelected(new Map());
                          setAllMatching(false);
                        }}
                        rows={[...selected.values()]}
                        filterString={filterString}
                      />
                    )}
                    <ResourceTable
                      items={list.data!.items}
                      sort={sort}
                      dir={dir}
                      onSort={(s) => url.update({ sort: s, dir: sort === s && dir === 'asc' ? 'desc' : s === 'cost' && sort !== s ? 'desc' : 'asc' })}
                      onScope={scopeTo}
                      selected={new Set(selected.keys())}
                      onToggle={toggle}
                      onToggleAll={toggleAll}
                    />
                  </>
                )}
              </div>
            ) : (
              <EmptyState
                compact
                icon={activeCount > 0 || resourceGroupId || scopeSub ? SearchX : Boxes}
                title={state === 'deleted' && activeCount === 0 ? 'No deleted resources' : activeCount > 0 ? 'No resources match these filters' : 'Nothing here'}
                description={
                  state === 'deleted' && activeCount === 0
                    ? 'Resources that disappear from Azure are flagged here after the next full sync.'
                    : activeCount > 0
                      ? 'Loosen or clear the filters to widen the search.'
                      : 'Pick another scope on the left, or run an Azure sync from the dashboard.'
                }
                action={
                  activeCount > 0 ? (
                    <Button variant="secondary" size="sm" onClick={clearAll}>
                      Clear filters
                    </Button>
                  ) : undefined
                }
              />
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
