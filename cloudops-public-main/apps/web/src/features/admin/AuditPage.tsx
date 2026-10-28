import { Fragment, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, ChevronRight, Download, History, Search } from 'lucide-react';
import type { AuditLogDto, AuditQuery } from '@cloudops/core';
import { downloadAuditCsv, useAuditActions, useAuditActors, useAuditLog } from '../../lib/queries';
import { apiErrorMessage } from '../../lib/api';
import { useDebounced } from '../../lib/useDebounced';
import {
  Badge,
  Button,
  Chip,
  EmptyState,
  ErrorState,
  Input,
  PageHeader,
  Pagination,
  Panel,
  Select,
  Spinner,
  TableSkeleton,
  TextButton,
  cn,
  type Tone,
} from '../../components/ui/primitives';
import { useToast } from '../../components/ui/Toast';
import { AdminGate } from './AdminGate';

const PAGE_SIZE = 50;
const RANGES = [
  { value: '', label: 'Any time' },
  { value: '1', label: 'Last 24 hours' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
] as const;

/** Colour the verbs that matter in an investigation. */
function actionTone(action: string): Tone {
  if (action.endsWith('.failed')) return 'danger';
  if (/\.(delete|deactivate|cancel|remove|revoke-all)$|password\.reset|\.reject$/.test(action))
    return 'warning';
  if (
    action.startsWith('provider.account') ||
    action.startsWith('user.') ||
    action.startsWith('auth.session')
  )
    return 'accent';
  return 'neutral';
}

/** Where the thing an event is about lives in the app. */
function targetLink(e: AuditLogDto): string | null {
  const id = e.entityId;
  switch (e.entity) {
    case 'user':
      return id ? `/settings/users?user=${id}` : null;
    case 'workItem':
      return id ? `/work/${id}` : null;
    case 'resource':
      return id ? `/inventory/${id}` : null;
    case 'standardRule':
      return id ? `/standards?rule=${id}` : null;
    case 'standard':
    case 'standards':
      return '/standards';
    case 'providerAccount':
      return '/providers';
    case 'budget':
      return '/finops?tab=budgets';
    case 'syncRun':
      return id ? `/operations/syncs?run=${id}` : '/operations/syncs';
    case 'costSync':
      return '/operations/syncs?tab=cost';
    case 'remediationRun':
      return id ? `/remediation/${id}` : null;
    case 'tags':
      return id ? `/inventory?resourceGroupId=${id}` : null;
    case 'job': {
      const [queue, job] = (id ?? '').split(':');
      return queue ? `/settings/system?queue=${queue}${job ? `&job=${job}` : ''}` : null;
    }
    default:
      return null;
  }
}

function Details({
  entry,
  onFilter,
}: {
  entry: AuditLogDto;
  onFilter: (k: 'requestId' | 'entityId' | 'actorId', v: string) => void;
}) {
  const link = targetLink(entry);
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-caption sm:grid-cols-[8rem_1fr]">
        <dt className="text-fg-muted">Target</dt>
        <dd className="flex flex-wrap items-center gap-2 font-mono text-fg-secondary">
          <span>
            {entry.entity}
            {entry.entityId ? ` · ${entry.entityId}` : ''}
          </span>
          {link && (
            <Link to={link} className="link inline-flex items-center gap-0.5 font-sans">
              Open <ArrowUpRight className="size-3" aria-hidden />
            </Link>
          )}
        </dd>
        <dt className="text-fg-muted">Request id</dt>
        <dd className="font-mono text-fg-secondary">{entry.requestId ?? '—'}</dd>
        <dt className="text-fg-muted">Details</dt>
        <dd>
          <pre className="max-h-60 overflow-auto rounded-xs border border-line-subtle bg-canvas p-2 font-mono text-caption text-fg-secondary">
            {entry.metadata ? JSON.stringify(entry.metadata, null, 2) : '—'}
          </pre>
        </dd>
      </dl>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-caption">
        {entry.requestId && (
          <TextButton onClick={() => onFilter('requestId', entry.requestId!)}>
            Everything in this request
          </TextButton>
        )}
        {entry.entityId && (
          <TextButton onClick={() => onFilter('entityId', entry.entityId!)}>
            Everything about this {entry.entity}
          </TextButton>
        )}
        {entry.actorId && (
          <TextButton onClick={() => onFilter('actorId', entry.actorId!)}>
            Everything by {entry.actor || 'this user'}
          </TextButton>
        )}
      </div>
    </div>
  );
}

function AuditLog() {
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const q = useDebounced(search.trim(), 300);
  const action = params.get('action') ?? '';
  const actorId = params.get('actorId') ?? '';
  const entityId = params.get('entityId') ?? '';
  const requestId = params.get('requestId') ?? '';
  const range = params.get('range') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [open, setOpen] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const actions = useAuditActions();
  const actors = useAuditActors();

  const set = (k: string, v: string | undefined) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k !== 'page') next.delete('page');
    setParams(next, { replace: k === 'q' || k === 'page' });
  };

  // Rounded to the minute so the query key is stable across renders.
  const from = range
    ? new Date(
        Math.floor((Date.now() - Number(range) * 86_400_000) / 60_000) * 60_000,
      ).toISOString()
    : undefined;
  const filters: Partial<AuditQuery> = {
    ...(q ? { search: q } : {}),
    ...(action ? { action } : {}),
    ...(actorId ? { actorId } : {}),
    ...(entityId ? { entityId } : {}),
    ...(requestId ? { requestId } : {}),
    ...(from ? { from } : {}),
  };
  const log = useAuditLog({ page, pageSize: PAGE_SIZE, ...filters });
  const data = log.data;
  const actorName = (id: string) =>
    actors.data?.find((a) => a.actorId === id)?.actor ?? `user ${id.slice(0, 8)}`;
  const filtered = Object.keys(filters).length > 0;

  async function exportCsv() {
    setExporting(true);
    try {
      const { truncated } = await downloadAuditCsv(filters);
      toast(
        truncated
          ? {
              tone: 'warning',
              title: 'Exported the newest 10,000 events',
              description: 'Narrow the filters to export the rest.',
            }
          : { title: 'Audit log exported' },
      );
    } catch (e) {
      toast({ tone: 'danger', title: 'Export failed', description: apiErrorMessage(e) });
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <PageHeader
        overline="Platform"
        title="Audit log"
        subtitle="Who did what, when, to which resource, and from where — sign-ins, account and credential changes, syncs, tag writes, remediations and deletions."
        actions={
          <Button
            variant="secondary"
            icon={Download}
            loading={exporting}
            onClick={() => void exportCsv()}
            disabled={!data?.total}
          >
            Export CSV
          </Button>
        }
      />
      <Panel className="mb-3" bodyClassName="flex flex-wrap items-center gap-2 p-3">
        <Input
          icon={Search}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            set('q', e.target.value.trim() || undefined);
          }}
          placeholder="Search actor, action or resource…"
          aria-label="Search the audit log"
          className="min-w-[min(100%,240px)] flex-1"
        />
        <Select
          value={actorId}
          onChange={(e) => set('actorId', e.target.value || undefined)}
          aria-label="Filter by person"
          selectClassName="max-w-[14rem]"
        >
          <option value="">Everyone</option>
          {actorId && !actors.data?.some((a) => a.actorId === actorId) && (
            <option value={actorId}>{actorName(actorId)}</option>
          )}
          {actors.data?.map((a) => (
            <option key={a.actorId} value={a.actorId}>
              {a.actor || a.actorId} ({a.events})
            </option>
          ))}
        </Select>
        <Select
          value={action}
          onChange={(e) => set('action', e.target.value || undefined)}
          aria-label="Filter by action"
          selectClassName="max-w-[16rem]"
        >
          <option value="">All actions</option>
          {actions.data?.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </Select>
        <Select
          value={range}
          onChange={(e) => set('range', e.target.value || undefined)}
          aria-label="Time range"
        >
          {RANGES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </Select>
        {log.isFetching && !log.isLoading && <Spinner label="Updating…" />}
      </Panel>
      {(entityId || requestId) && (
        <div className="mb-3 flex flex-wrap gap-2">
          {requestId && (
            <Chip
              label={`Request ${requestId.slice(0, 12)}`}
              onRemove={() => set('requestId', undefined)}
            />
          )}
          {entityId && (
            <Chip
              label={`About ${entityId.length > 24 ? `${entityId.slice(0, 24)}…` : entityId}`}
              onRemove={() => set('entityId', undefined)}
            />
          )}
        </div>
      )}

      <Panel
        flush
        title={
          <span className="flex items-center gap-2">
            Events{' '}
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
              noun="events"
              onPrev={() => set('page', String(Math.max(1, page - 1)))}
              onNext={() => set('page', String(page + 1))}
            />
          ) : undefined
        }
      >
        {log.isLoading ? (
          <TableSkeleton rows={10} cols={5} />
        ) : log.isError ? (
          <ErrorState compact error={log.error} onRetry={() => void log.refetch()} />
        ) : !data?.items.length ? (
          <EmptyState
            compact
            icon={History}
            title={filtered ? 'No events match these filters' : 'No audit events yet'}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table data-table--compact">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Action</th>
                  <th scope="col" className="hidden lg:table-cell">
                    Target
                  </th>
                  <th scope="col" className="hidden md:table-cell">
                    IP
                  </th>
                  <th scope="col">
                    <span className="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((e) => {
                  const expanded = open === e.id;
                  const meta = (e.metadata ?? {}) as Record<string, unknown>;
                  const target = (meta.name ??
                    meta.title ??
                    meta.email ??
                    e.entityId ??
                    '') as string;
                  return (
                    <Fragment key={e.id}>
                      <tr
                        data-interactive
                        data-expanded={expanded || undefined}
                        onClick={() => setOpen(expanded ? null : e.id)}
                      >
                        <td className="whitespace-nowrap font-mono text-caption">
                          {new Date(e.createdAt).toLocaleString()}
                        </td>
                        <td className="max-w-[14rem] truncate text-fg">
                          {e.actor || (
                            // '' = a user action recorded before actor names were captured.
                            <span className="text-fg-muted">
                              {e.actor === '' || e.actorId ? 'unknown user' : 'system'}
                            </span>
                          )}
                        </td>
                        <td>
                          <Badge tone={actionTone(e.action)} mono>
                            {e.action}
                          </Badge>
                        </td>
                        <td className="hidden max-w-[18rem] truncate lg:table-cell">
                          {String(target)}
                        </td>
                        <td className="hidden font-mono text-caption md:table-cell">
                          {e.ip ?? '—'}
                        </td>
                        <td className="w-8">
                          <button
                            type="button"
                            aria-expanded={expanded}
                            aria-label={expanded ? 'Hide details' : 'Show details'}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              setOpen(expanded ? null : e.id);
                            }}
                            className="grid size-6 place-items-center rounded-xs text-fg-muted hover:text-fg"
                          >
                            <ChevronRight
                              className={cn(
                                'size-4 transition-transform duration-150',
                                expanded && 'rotate-90',
                              )}
                              aria-hidden
                            />
                          </button>
                        </td>
                      </tr>
                      {expanded && (
                        <tr>
                          <td colSpan={6} className="!bg-canvas/60 !py-3">
                            <Details
                              entry={e}
                              onFilter={(k, v) => {
                                setOpen(null);
                                set(k, v);
                              }}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}

export function AuditPage() {
  return (
    <AdminGate permission="audit.read">
      <AuditLog />
    </AdminGate>
  );
}
