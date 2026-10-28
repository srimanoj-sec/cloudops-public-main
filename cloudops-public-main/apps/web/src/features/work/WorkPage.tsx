import { useMemo, useState, type DragEvent, type KeyboardEvent } from 'react';
import { CalendarClock, MessageSquare, Plus, Repeat, Search, User } from 'lucide-react';
import { WORK_ITEM_TYPES, type WorkItemDto, type WorkItemStateDto } from '@cloudops/core';
import { useUpdateWorkItem, useWorkItems, useWorkSummary } from '../../lib/queries';
import { useOrg } from '../../lib/orgContext';
import { usePermissions } from '../../lib/auth';
import {
  Badge,
  Button,
  ErrorState,
  Input,
  PageHeader,
  Panel,
  Readout,
  ReadoutGrid,
  Select,
  Skeleton,
  Spinner,
  TONE_FILL,
  cn,
} from '../../components/ui/primitives';
import {
  Avatar,
  STATE_LABEL,
  STATE_ORDER,
  STATE_TONE,
  WorkItemDialog,
  isOverdue,
  priorityTone,
  scopeChipLabel,
} from './shared';

function WorkCard({
  item,
  canEdit,
  dragging,
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  item: WorkItemDto;
  canEdit: boolean;
  dragging: boolean;
  onOpen: () => void;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
}) {
  const overdue = isOverdue(item);
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen();
    }
  }
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${item.title} — priority ${item.priority}${overdue ? ', overdue' : ''}`}
      draggable={canEdit}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      onKeyDown={onKeyDown}
      className={cn(
        'group cursor-pointer rounded-sm border border-line bg-raised p-3 transition-[border-color,background-color,opacity,transform] duration-150',
        'hover:border-line-strong hover:bg-hover/60 active:translate-y-px',
        canEdit && 'cursor-grab active:cursor-grabbing',
        dragging && 'opacity-40',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 text-body-sm font-medium leading-snug text-fg">{item.title}</div>
        <Badge tone={priorityTone(item.priority)} mono className="shrink-0">
          P{item.priority}
        </Badge>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge>{item.type}</Badge>
        {item.recurrence && (
          <Badge tone="info">
            <Repeat className="-ml-0.5 mr-1 inline size-3" aria-hidden />
            {item.recurrence}
          </Badge>
        )}
        {item.links.map((l) => (
          <Badge key={l.id} mono className="max-w-[12rem]">
            {scopeChipLabel(l)}
          </Badge>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-line-subtle pt-2.5 text-caption text-fg-muted">
        <span className="flex min-w-0 items-center gap-1.5">
          {item.assignee ? (
            <>
              <Avatar name={item.assignee} />
              <span className="truncate text-fg-secondary">{item.assignee}</span>
            </>
          ) : (
            <span className="italic text-fg-faint">unassigned</span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-3">
          {item.commentCount > 0 && (
            <span className="flex items-center gap-1" title="Comments">
              <MessageSquare className="size-3.5" aria-hidden />
              <span className="font-mono tabular-nums">{item.commentCount}</span>
              <span className="sr-only">comments</span>
            </span>
          )}
          {item.dueDate && (
            <span
              className={cn(
                'flex items-center gap-1 font-mono tabular-nums',
                overdue && 'font-medium text-danger',
              )}
            >
              <CalendarClock className="size-3.5" aria-hidden />
              {overdue && <span className="font-sans">Overdue ·</span>}
              {new Date(item.dueDate).toLocaleDateString()}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

export function WorkPage() {
  const { tenantId } = useOrg();
  const { can } = usePermissions();
  const canEdit = can('work.manage');

  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [assignee, setAssignee] = useState('');
  const [dialog, setDialog] = useState<
    { mode: 'new' } | { mode: 'edit'; item: WorkItemDto } | null
  >(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<WorkItemStateDto | null>(null);

  const query = {
    tenantId: tenantId || undefined,
    search: search || undefined,
    type: type || undefined,
    assignee: assignee || undefined,
  };
  const items = useWorkItems(query);
  const summary = useWorkSummary({ tenantId: tenantId || undefined });
  const update = useUpdateWorkItem();

  const byState = useMemo(() => {
    const map: Record<WorkItemStateDto, WorkItemDto[]> = {
      todo: [],
      in_progress: [],
      blocked: [],
      done: [],
    };
    for (const it of items.data ?? []) map[it.state].push(it);
    return map;
  }, [items.data]);

  function moveTo(id: string, state: WorkItemStateDto) {
    if (!canEdit) return;
    update.mutate({ id, input: { state } });
  }

  return (
    <div>
      <PageHeader
        overline="Work"
        title="Work boards"
        subtitle="Track every cloud activity as a work item — create tasks from any resource, resource group, subscription or organization."
        actions={
          canEdit ? (
            <Button icon={Plus} onClick={() => setDialog({ mode: 'new' })}>
              New task
            </Button>
          ) : undefined
        }
      />

      {/* Summary strip */}
      {summary.data && (
        <div className="mb-6">
          <ReadoutGrid className="grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))]">
            <Readout
              size="sm"
              label="Open"
              value={summary.data.total - summary.data.byState.done}
            />
            {STATE_ORDER.map((s) => (
              <Readout key={s} size="sm" label={STATE_LABEL[s]} value={summary.data!.byState[s]} />
            ))}
            {summary.data.overdue > 0 && (
              <Readout size="sm" label="Overdue" value={summary.data.overdue} tone="danger" />
            )}
          </ReadoutGrid>
        </div>
      )}

      {/* Filters */}
      <Panel className="mb-4" bodyClassName="flex flex-wrap items-center gap-2 p-3">
        <Input
          icon={Search}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search title / description…"
          aria-label="Search work items"
          className="min-w-[min(100%,220px)] flex-1"
        />
        <Select value={type} onChange={(e) => setType(e.target.value)} aria-label="Filter by type">
          <option value="">All types</option>
          {WORK_ITEM_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
        <Input
          icon={User}
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
          placeholder="Assignee"
          aria-label="Filter by assignee"
          className="w-44"
        />
        {items.isFetching && !items.isLoading && <Spinner label="Updating…" />}
      </Panel>

      {items.isLoading ? (
        <div
          className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4"
          role="status"
          aria-label="Loading work items"
        >
          {STATE_ORDER.map((s) => (
            <div key={s} className="space-y-2 rounded-md border border-line bg-surface/60 p-3">
              <Skeleton className="mb-3 h-4 w-24" />
              <Skeleton className="h-24" />
              <Skeleton className="h-24" />
            </div>
          ))}
        </div>
      ) : items.isError ? (
        <ErrorState
          title="Couldn’t load work items"
          error={items.error}
          onRetry={() => void items.refetch()}
          retrying={items.isRefetching}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {STATE_ORDER.map((s) => {
            const isOver = overCol === s && draggingId !== null;
            return (
              <section
                key={s}
                aria-label={`${STATE_LABEL[s]} — ${byState[s].length} items`}
                onDragOver={(e) => {
                  if (!canEdit) return;
                  e.preventDefault();
                  if (overCol !== s) setOverCol(s);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node))
                    setOverCol((c) => (c === s ? null : c));
                }}
                onDrop={(e) => {
                  setOverCol(null);
                  const id = e.dataTransfer.getData('text/plain');
                  if (id) moveTo(id, s);
                }}
                className={cn(
                  'flex min-h-[12rem] flex-col rounded-md border bg-surface/60 transition-[border-color,background-color] duration-150',
                  isOver ? 'border-accent/60 bg-accent/[0.04]' : 'border-line',
                )}
              >
                <header className="flex items-center justify-between gap-2 border-b border-line-subtle px-3 py-2.5">
                  <h3 className="flex items-center gap-2 text-body-sm font-semibold text-fg">
                    <span
                      aria-hidden
                      className={cn('size-2 rounded-full', TONE_FILL[STATE_TONE[s]])}
                    />
                    {STATE_LABEL[s]}
                  </h3>
                  <span className="rounded-xs bg-raised px-1.5 py-px font-mono text-caption tabular-nums text-fg-muted">
                    {byState[s].length}
                  </span>
                </header>
                <div className="flex-1 space-y-2 p-2">
                  {byState[s].map((item) => (
                    <WorkCard
                      key={item.id}
                      item={item}
                      canEdit={canEdit}
                      dragging={draggingId === item.id}
                      onOpen={() => setDialog({ mode: 'edit', item })}
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', item.id);
                        e.dataTransfer.effectAllowed = 'move';
                        setDraggingId(item.id);
                      }}
                      onDragEnd={() => {
                        setDraggingId(null);
                        setOverCol(null);
                      }}
                    />
                  ))}
                  {byState[s].length === 0 && (
                    <div
                      className={cn(
                        'grid h-20 place-items-center rounded-sm border border-dashed text-caption transition-colors duration-150',
                        isOver ? 'border-accent/60 text-accent' : 'border-line text-fg-faint',
                      )}
                    >
                      {isOver ? 'Drop to move here' : 'Nothing here'}
                    </div>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {dialog?.mode === 'new' && <WorkItemDialog onClose={() => setDialog(null)} />}
      {dialog?.mode === 'edit' && (
        <WorkItemDialog item={dialog.item} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}
