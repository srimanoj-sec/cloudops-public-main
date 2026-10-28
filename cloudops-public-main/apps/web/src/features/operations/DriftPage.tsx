import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowRight,
  GitCompareArrows,
  History,
  Search,
  SquareKanban,
  Undo2,
  UserSearch,
} from 'lucide-react';
import type { DriftChangeDto } from '@cloudops/core';
import { useDrift, useDriftActivity, useDriftChange } from '../../lib/queries';
import { usePermissions } from '../../lib/auth';
import { useOrg } from '../../lib/orgContext';
import { shortType, timeAgo } from '../../lib/format';
import { useDebounced } from '../../lib/useDebounced';
import {
  Alert,
  Badge,
  Button,
  Chip,
  DescriptionList,
  EmptyState,
  ErrorState,
  Input,
  LoadingBlock,
  PageHeader,
  Pagination,
  Panel,
  Select,
  TableSkeleton,
  cn,
} from '../../components/ui/primitives';
import { Modal } from '../../components/ui/Modal';
import { useCreateWork } from '../work/CreateWork';

const PAGE_SIZE = 50;
const WINDOWS = [
  { value: '1', label: 'Last 24 hours' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: 'all', label: 'All time' },
] as const;

const FIELD_LABEL: Record<string, string> = {
  tags: 'Tags',
  owner: 'Owner',
  sku: 'SKU',
  location: 'Location',
  state: 'State',
  name: 'Name',
  type: 'Type',
};

function fmt(v: unknown, max = 60): string {
  if (v == null || v === '') return '—';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max - 3)}…` : s;
}

type TagMap = Record<string, string>;
const isTagMap = (v: unknown): v is TagMap =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Key-level tag diff: what was added, removed and changed. */
function tagDiff(oldV: unknown, newV: unknown) {
  const a = isTagMap(oldV) ? oldV : {};
  const b = isTagMap(newV) ? newV : {};
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort((x, y) =>
    x.localeCompare(y),
  );
  return keys
    .map((k) => ({ key: k, before: a[k], after: b[k] }))
    .filter((d) => d.before !== d.after)
    .map((d) => ({
      ...d,
      kind:
        d.before === undefined
          ? ('added' as const)
          : d.after === undefined
            ? ('removed' as const)
            : ('changed' as const),
    }));
}

/** One-line summary of a change for the list. */
function summary(c: DriftChangeDto): string {
  if (c.field === 'tags') {
    const d = tagDiff(c.oldValue, c.newValue);
    const n = (k: string) => d.filter((x) => x.kind === k).length;
    const parts = [
      n('added') && `${n('added')} added`,
      n('removed') && `${n('removed')} removed`,
      n('changed') && `${n('changed')} changed`,
    ].filter(Boolean);
    const keys = d
      .slice(0, 3)
      .map((x) => x.key)
      .join(', ');
    return `${parts.join(', ') || 'reordered'}${keys ? ` — ${keys}${d.length > 3 ? '…' : ''}` : ''}`;
  }
  return `${fmt(c.oldValue, 40)} → ${fmt(c.newValue, 40)}`;
}

/**
 * Configuration drift: every field-level change the syncs (and manual
 * refreshes) detected, who made it (from the provider's activity log, on
 * demand), and a way back — restore previous tags as a reviewed remediation.
 */
export function DriftPage() {
  const [params, setParams] = useSearchParams();
  const { tenantId } = useOrg();
  const field = params.get('field') ?? undefined;
  const windowDays = params.get('window') ?? '30';
  const runId = params.get('run') ?? undefined;
  const resourceId = params.get('resource') ?? undefined;
  const eventId = params.get('event');
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [search, setSearch] = useState(params.get('q') ?? '');
  const q = useDebounced(search.trim(), 300);

  const set = (k: string, v: string | undefined) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k !== 'page' && k !== 'event') next.delete('page');
    setParams(next, { replace: k !== 'event' });
  };

  // The window's start, rounded to the minute so the query key is stable between renders.
  const from =
    windowDays === 'all'
      ? undefined
      : new Date(
          Math.floor((Date.now() - Number(windowDays) * 86_400_000) / 60_000) * 60_000,
        ).toISOString();
  const drift = useDrift({
    field,
    from,
    page,
    pageSize: PAGE_SIZE,
    ...(q ? { search: q } : {}),
    ...(tenantId ? { tenantId } : {}),
    ...(runId ? { syncRunId: runId } : {}),
    ...(resourceId ? { resourceId } : {}),
  });
  const data = drift.data;
  const allCount = data?.fields.reduce((a, f) => a + f.count, 0) ?? 0;

  return (
    <div>
      <PageHeader
        overline="Operations"
        title="Configuration drift"
        subtitle="Changes made outside CloudOps, found by each sync: what changed, from what to what, and — from the activity log — who changed it."
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input
          icon={Search}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            set('q', e.target.value.trim() || undefined);
          }}
          placeholder="Resource name…"
          aria-label="Search resources"
          controlSize="sm"
          className="w-full sm:w-64"
        />
        <Select
          value={windowDays}
          onChange={(e) => set('window', e.target.value === '30' ? undefined : e.target.value)}
          aria-label="Time window"
          controlSize="sm"
        >
          {WINDOWS.map((w) => (
            <option key={w.value} value={w.value}>
              {w.label}
            </option>
          ))}
        </Select>
        {runId && (
          <Chip label={`Sync run ${runId.slice(0, 8)}`} onRemove={() => set('run', undefined)} />
        )}
        {resourceId && <Chip label="One resource" onRemove={() => set('resource', undefined)} />}
      </div>

      {data && data.fields.length > 0 && (
        <div role="group" aria-label="Filter by field" className="mb-4 flex flex-wrap gap-1.5">
          <FieldChip
            label="Every field"
            count={allCount}
            active={!field}
            onClick={() => set('field', undefined)}
          />
          {data.fields.map((f) => (
            <FieldChip
              key={f.field}
              label={FIELD_LABEL[f.field] ?? f.field}
              count={f.count}
              active={field === f.field}
              onClick={() => set('field', field === f.field ? undefined : f.field)}
            />
          ))}
        </div>
      )}

      <Panel
        flush
        title={
          <span className="flex items-center gap-2">
            Changes{' '}
            {data && <span className="font-mono font-normal text-fg-muted">{data.total}</span>}
          </span>
        }
        footer={
          data && data.total > PAGE_SIZE ? (
            <Pagination
              page={data.page}
              totalPages={data.totalPages}
              total={data.total}
              pageSize={PAGE_SIZE}
              noun="changes"
              onPrev={() => set('page', String(page - 1))}
              onNext={() => set('page', String(page + 1))}
            />
          ) : undefined
        }
      >
        {drift.isLoading ? (
          <TableSkeleton rows={8} cols={4} />
        ) : drift.isError ? (
          <ErrorState compact error={drift.error} onRetry={() => void drift.refetch()} />
        ) : !data?.items.length ? (
          <EmptyState
            compact
            icon={GitCompareArrows}
            title="No drift in this window"
            description={
              q || field || runId || resourceId
                ? 'Nothing matches these filters — widen the window or clear a filter.'
                : 'Each sync compares tags, owner, SKU and location with what it saw last time; changes will appear here.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Resource</th>
                  <th scope="col">Change</th>
                  <th scope="col" className="hidden lg:table-cell">
                    Found by
                  </th>
                  <th scope="col" className="num">
                    Detected
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((c) => (
                  <tr key={c.id} data-interactive onClick={() => set('event', c.id)}>
                    <td className="max-w-[18rem]">
                      <Link
                        to={`/inventory/${c.resourceId}`}
                        onClick={(e) => e.stopPropagation()}
                        className="link-quiet block truncate font-medium"
                      >
                        {c.resourceName ?? 'resource'}
                      </Link>
                      <div className="truncate text-caption text-fg-muted">
                        {[c.resourceType && shortType(c.resourceType), c.resourceGroup]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    </td>
                    <td className="max-w-[28rem]">
                      <div className="flex min-w-0 items-center gap-2">
                        <Badge mono>{FIELD_LABEL[c.field] ?? c.field}</Badge>
                        <button
                          type="button"
                          className="link-quiet truncate text-left font-mono text-caption"
                          onClick={(e) => (e.stopPropagation(), set('event', c.id))}
                        >
                          {summary(c)}
                        </button>
                      </div>
                    </td>
                    <td className="hidden text-caption lg:table-cell">
                      {c.syncRunId ? (
                        <Link
                          to={`/operations/syncs?run=${c.syncRunId}`}
                          onClick={(e) => e.stopPropagation()}
                          className="link-quiet"
                        >
                          sync
                        </Link>
                      ) : (
                        <span className="text-fg-muted">manual refresh</span>
                      )}
                    </td>
                    <td
                      className="num whitespace-nowrap font-mono text-caption text-fg-muted"
                      title={new Date(c.detectedAt).toLocaleString()}
                    >
                      {timeAgo(c.detectedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {eventId && <ChangeDetail id={eventId} onClose={() => set('event', undefined)} />}
    </div>
  );
}

function FieldChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-xs border px-2.5 text-caption transition-colors duration-150',
        active
          ? 'border-accent/40 bg-accent/10 text-accent'
          : 'border-line bg-raised text-fg-secondary hover:bg-hover hover:text-fg',
      )}
    >
      {label}
      <span className="font-mono text-fg-muted">{count}</span>
    </button>
  );
}

function ChangeDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const change = useDriftChange(id);
  const [lookup, setLookup] = useState(false);
  const activity = useDriftActivity(id, lookup);
  const { can } = usePermissions();
  const createWork = useCreateWork();
  const c = change.data;
  const diff = c?.field === 'tags' ? tagDiff(c.oldValue, c.newValue) : null;
  const canRestore = Boolean(
    c && c.field === 'tags' && isTagMap(c.oldValue) && can('remediation.request'),
  );

  return (
    <Modal
      size="lg"
      title={c ? `${FIELD_LABEL[c.field] ?? c.field} changed` : 'Change'}
      description={
        c
          ? `${c.resourceName ?? 'resource'} · detected ${new Date(c.detectedAt).toLocaleString()}`
          : undefined
      }
      onClose={onClose}
      footer={
        c && (
          <div className="flex w-full flex-wrap items-center justify-end gap-2">
            <Link
              to={`/inventory/${c.resourceId}?tab=History`}
              className="link mr-auto inline-flex items-center gap-1 text-body-sm"
            >
              <History className="size-3.5" aria-hidden /> Resource history
            </Link>
            {can('work.manage') && (
              <Button
                variant="ghost"
                icon={SquareKanban}
                onClick={() =>
                  createWork({
                    defaults: {
                      title: `Review ${FIELD_LABEL[c.field]?.toLowerCase() ?? c.field} change on ${c.resourceName ?? 'resource'}`,
                      type: 'change',
                      description: `Detected ${new Date(c.detectedAt).toLocaleString()}: ${summary(c)}`,
                    },
                    source: {
                      type: 'drift',
                      id: c.id,
                      label: `${c.resourceName ?? 'resource'} · ${c.field}`,
                    },
                    scopes: [
                      {
                        scopeType: 'resource',
                        scopeId: c.resourceId,
                        scopeName: c.resourceName ?? undefined,
                      },
                    ],
                  })
                }
              >
                Work item
              </Button>
            )}
            {canRestore && (
              <Link
                to={`/remediation/new?action=tags.restore&resources=${c.resourceId}&p.tags=${encodeURIComponent(JSON.stringify(c.oldValue))}`}
                className="inline-flex h-9 items-center gap-2 rounded-sm border border-line-strong bg-raised px-4 text-body font-medium text-fg transition-colors duration-150 hover:border-fg-faint hover:bg-hover"
              >
                <Undo2 className="size-4" aria-hidden /> Restore previous tags
              </Link>
            )}
          </div>
        )
      }
    >
      {change.isLoading ? (
        <LoadingBlock label="Loading change…" />
      ) : change.isError || !c ? (
        <ErrorState compact error={change.error} onRetry={() => void change.refetch()} />
      ) : (
        <div className="space-y-5">
          <DescriptionList
            items={[
              {
                label: 'Resource',
                value: (
                  <Link to={`/inventory/${c.resourceId}`} className="link">
                    {c.resourceName ?? c.resourceId}
                  </Link>
                ),
              },
              {
                label: 'Where',
                value: [c.subscription, c.resourceGroup].filter(Boolean).join(' / ') || '—',
              },
              {
                label: 'Found by',
                value: c.syncRunId ? (
                  <Link to={`/operations/syncs?run=${c.syncRunId}`} className="link">
                    Sync run · {new Date(c.detectedAt).toLocaleString()}
                  </Link>
                ) : (
                  'A manual refresh'
                ),
              },
            ]}
          />

          <section>
            <h3 className="mb-2 text-body-sm font-medium text-fg">What changed</h3>
            {diff ? (
              diff.length === 0 ? (
                <p className="text-caption text-fg-muted">Same tags, different order or casing.</p>
              ) : (
                <div className="overflow-x-auto rounded-sm border border-line">
                  <table className="data-table data-table--compact">
                    <thead>
                      <tr>
                        <th scope="col">Tag</th>
                        <th scope="col">Before</th>
                        <th scope="col">After</th>
                      </tr>
                    </thead>
                    <tbody>
                      {diff.map((d) => (
                        <tr key={d.key}>
                          <td className="font-mono text-caption">
                            {d.key}{' '}
                            <Badge
                              tone={
                                d.kind === 'removed'
                                  ? 'danger'
                                  : d.kind === 'added'
                                    ? 'success'
                                    : 'warning'
                              }
                            >
                              {d.kind}
                            </Badge>
                          </td>
                          <td className="font-mono text-caption text-fg-muted">
                            {d.before ?? '—'}
                          </td>
                          <td className="font-mono text-caption">{d.after ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="rounded-sm border border-line bg-canvas/60 p-3">
                  <div className="mb-1 font-mono text-overline uppercase text-fg-muted">Before</div>
                  <pre className="whitespace-pre-wrap break-all font-mono text-caption text-fg-secondary">
                    {fmt(c.oldValue, 2000)}
                  </pre>
                </div>
                <div className="rounded-sm border border-line bg-canvas/60 p-3">
                  <div className="mb-1 font-mono text-overline uppercase text-fg-muted">After</div>
                  <pre className="whitespace-pre-wrap break-all font-mono text-caption text-fg">
                    {fmt(c.newValue, 2000)}
                  </pre>
                </div>
              </div>
            )}
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-body-sm font-medium text-fg">Who changed it</h3>
              {!lookup && (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={UserSearch}
                  onClick={() => setLookup(true)}
                >
                  Check the activity log
                </Button>
              )}
            </div>
            {!lookup ? (
              <p className="text-caption text-fg-muted">
                Reads the provider’s activity log for this resource in the week before the change
                was detected (read-only).
              </p>
            ) : activity.isLoading ? (
              <LoadingBlock label="Reading the activity log…" />
            ) : activity.isError ? (
              <ErrorState compact error={activity.error} onRetry={() => void activity.refetch()} />
            ) : !activity.data?.available ? (
              <Alert tone="info" title="Activity log unavailable">
                {activity.data?.reason}
              </Alert>
            ) : activity.data.entries.length === 0 ? (
              <p className="text-caption text-fg-muted">
                No write operations on this resource between{' '}
                {new Date(activity.data.window.from).toLocaleDateString()} and{' '}
                {new Date(activity.data.window.to).toLocaleDateString()}. Tag changes inherited from
                policy or made on a parent may not show here.
              </p>
            ) : (
              <ul className="divide-y divide-line-subtle rounded-sm border border-line">
                {activity.data.entries.map((e, i) => (
                  <li
                    key={`${e.correlationId ?? i}-${e.at}`}
                    className="grid grid-cols-1 gap-1 px-3 py-2 text-caption sm:grid-cols-[10rem_minmax(0,1fr)_auto] sm:gap-3"
                  >
                    <span className="font-mono text-fg-muted">
                      {new Date(e.at).toLocaleString()}
                    </span>
                    <span className="min-w-0">
                      <span className="font-medium text-fg">{e.caller ?? 'unknown caller'}</span>
                      <span className="block truncate font-mono text-fg-muted">{e.operation}</span>
                    </span>
                    {e.status && (
                      <Badge
                        tone={
                          /succe/i.test(e.status)
                            ? 'success'
                            : /fail/i.test(e.status)
                              ? 'danger'
                              : 'neutral'
                        }
                      >
                        {e.status}
                      </Badge>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {canRestore && (
            <p className="flex items-start gap-1.5 text-caption text-fg-muted">
              <ArrowRight className="mt-0.5 size-3 shrink-0" aria-hidden />
              Restoring opens a remediation plan first: you’ll see the exact tags that will be set
              (tags added since are removed) before anything changes.
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
