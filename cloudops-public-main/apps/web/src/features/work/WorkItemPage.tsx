import { useState } from 'react';
import axios from 'axios';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Boxes, Building2, FolderTree, KeyRound, MessageSquare, Pencil, SearchX, Trash2 } from 'lucide-react';
import { WORK_RECURRENCES, type WorkItemDetailDto, type WorkItemStateDto } from '@cloudops/core';
import { useAddWorkComment, useDeleteWorkItem, useDirectory, useUpdateWorkItem, useWorkItem } from '../../lib/queries';
import { usePermissions } from '../../lib/auth';
import { apiErrorMessage } from '../../lib/api';
import { useRecordVisit } from '../../lib/recent';
import { renderMarkdown } from '../workspaces/markdown';
import {
  Badge,
  Button,
  DescriptionList,
  EmptyState,
  ErrorState,
  IconButton,
  InlineError,
  Input,
  LoadingBlock,
  PageHeader,
  Panel,
  Select,
} from '../../components/ui/primitives';
import { useConfirm } from '../../components/ui/Dialogs';
import { useToast } from '../../components/ui/Toast';
import { MentionInput } from './MentionInput';
import { Avatar, STATE_LABEL, STATE_ORDER, STATE_TONE, SourceChip, WorkItemDialog, isOverdue, priorityTone } from './shared';

const SCOPE_ICON = { organization: Building2, subscription: KeyRound, resourceGroup: FolderTree, resource: Boxes } as const;

function scopeLink(l: WorkItemDetailDto['links'][number]): string {
  switch (l.scopeType) {
    case 'resource':
      return `/inventory/${l.scopeId}`;
    case 'resourceGroup':
      return `/inventory?resourceGroupId=${l.scopeId}`;
    case 'subscription':
      return `/inventory?subscriptionId=${l.scopeId}`;
    default:
      return `/organizations#${l.scopeId}`;
  }
}

/** Highlight @mentions of known people in a comment (plain text otherwise). */
function CommentBody({ body, people }: { body: string; people: string[] }) {
  if (!people.length || !body.includes('@')) return <>{body}</>;
  const names = [...people].sort((a, b) => b.length - a.length).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const parts = body.split(new RegExp(`(@(?:${names.join('|')}))`, 'gi'));
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('@') && names.some((n) => new RegExp(`^@${n}$`, 'i').test(p)) ? (
          <span key={i} className="rounded-xs bg-accent/10 px-0.5 text-accent">
            {p}
          </span>
        ) : (
          p
        ),
      )}
    </>
  );
}

export function WorkItemPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { can } = usePermissions();
  const canEdit = can('work.manage');
  const item = useWorkItem(id);
  const update = useUpdateWorkItem();
  const del = useDeleteWorkItem();
  const addComment = useAddWorkComment();
  const people = useDirectory();
  const confirm = useConfirm();
  const toast = useToast();
  const [comment, setComment] = useState('');
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const names = (people.data ?? []).map((p) => p.name);

  const data = item.data;
  useRecordVisit(data ? { kind: 'workItem', id: data.id, title: data.title, subtitle: `${data.type} · ${STATE_LABEL[data.state]}`, link: `/work/${data.id}` } : null);

  if (item.isLoading) return <LoadingBlock label="Loading work item…" className="min-h-[40vh]" />;
  const notFound = axios.isAxiosError(item.error) && item.error.response?.status === 404;
  if (item.isError && !notFound) return <ErrorState error={item.error} onRetry={() => void item.refetch()} />;
  if (!data)
    return (
      <EmptyState
        icon={SearchX}
        title="Work item not found"
        description="It may have been deleted."
        action={
          <Link to="/work" className="link text-body-sm">
            Back to work boards
          </Link>
        }
      />
    );

  const save = (input: Parameters<typeof update.mutate>[0]['input']) => {
    setError(null);
    update.mutate({ id: data.id, input }, { onError: (e) => setError(apiErrorMessage(e)) });
  };

  async function post() {
    if (!comment.trim()) return;
    try {
      await addComment.mutateAsync({ id: data!.id, body: comment.trim() });
      setComment('');
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  }

  async function remove() {
    const ok = await confirm({
      title: 'Delete this work item?',
      description: `“${data!.title}” and its comments will be permanently deleted. The deletion is recorded in the audit log.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await del.mutateAsync(data!.id);
      toast({ title: 'Work item deleted' });
      navigate('/work');
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  }

  const overdue = isOverdue(data);
  // Comments and activity as one timeline.
  const timeline = [
    ...data.activity.filter((a) => a.action !== 'work.item.comment').map((a) => ({ kind: 'activity' as const, at: a.at, a })),
    ...data.comments.map((c) => ({ kind: 'comment' as const, at: c.createdAt, c })),
  ].sort((x, y) => x.at.localeCompare(y.at));

  return (
    <div>
      <PageHeader
        overline={`Work item · ${data.type}`}
        title={data.title}
        meta={
          <>
            <Badge tone={STATE_TONE[data.state]} dot>
              {STATE_LABEL[data.state]}
            </Badge>
            <Badge tone={priorityTone(data.priority)} mono>
              P{data.priority}
            </Badge>
            {overdue && <Badge tone="danger">Overdue</Badge>}
            {data.recurrence && <Badge tone="info">{data.recurrence} review</Badge>}
            {data.source && <SourceChip source={data.source} />}
          </>
        }
        actions={
          canEdit ? (
            <>
              <Button variant="secondary" icon={Pencil} onClick={() => setEditing(true)}>
                Edit
              </Button>
              <IconButton icon={Trash2} label="Delete work item" variant="danger-ghost" onClick={() => void remove()} />
            </>
          ) : undefined
        }
      >
        <Link to="/work" className="mb-4 inline-flex items-center gap-1.5 text-body-sm text-fg-muted transition-colors duration-150 hover:text-fg">
          <ArrowLeft className="size-4" aria-hidden /> Work boards
        </Link>
      </PageHeader>

      {error && <InlineError className="mb-4">{error}</InlineError>}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-4">
          <Panel title="Description">
            {data.description ? (
              <div className="md-prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(data.description) }} />
            ) : (
              <p className="text-body-sm text-fg-muted">No description.</p>
            )}
          </Panel>

          <Panel title="Linked to" description={data.links.length ? undefined : 'Not linked to any resource or scope.'} flush={data.links.length > 0}>
            {data.links.length > 0 && (
              <ul className="divide-y divide-line-subtle">
                {data.links.map((l) => {
                  const Icon = SCOPE_ICON[l.scopeType as keyof typeof SCOPE_ICON] ?? Boxes;
                  return (
                    <li key={l.id}>
                      <Link to={scopeLink(l)} className="focus-inset flex items-center gap-3 px-4 py-2.5 text-body-sm transition-colors duration-150 hover:bg-hover/50 md:px-5">
                        <Icon className="size-4 text-fg-muted" aria-hidden />
                        <span className="min-w-0 flex-1 truncate text-fg">{l.scopeName ?? l.scopeId}</span>
                        <span className="text-caption text-fg-muted">{l.scopeType}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>

          <Panel
            title={
              <span className="flex items-center gap-2">
                <MessageSquare className="size-4 text-fg-muted" aria-hidden /> Discussion & activity
              </span>
            }
          >
            {timeline.length === 0 ? (
              <p className="text-body-sm text-fg-muted">Nothing yet.</p>
            ) : (
              <ol className="relative ml-2 border-l border-line">
                {timeline.map((t) =>
                  t.kind === 'comment' ? (
                    <li key={`c-${t.c.id}`} className="relative pb-4 pl-6 last:pb-0">
                      <Avatar name={t.c.author} className="absolute -left-2.5 top-0 size-5 bg-surface" />
                      <div className="flex flex-wrap items-baseline gap-x-2 text-caption">
                        <span className="font-medium text-fg-secondary">{t.c.author}</span>
                        <span className="font-mono text-fg-muted">{new Date(t.c.createdAt).toLocaleString()}</span>
                      </div>
                      <div className="mt-1 whitespace-pre-wrap rounded-sm border border-line-subtle bg-canvas/60 px-3 py-2 text-body-sm text-fg">
                        <CommentBody body={t.c.body} people={names} />
                      </div>
                    </li>
                  ) : (
                    <li key={`a-${t.a.id}`} className="relative pb-4 pl-6 last:pb-0">
                      <span aria-hidden className="absolute -left-[4.5px] top-1.5 size-2 rounded-full border-2 border-surface bg-fg-faint" />
                      <p className="text-caption text-fg-muted">
                        <span className="text-fg-secondary">{t.a.actor ?? 'System'}</span> {t.a.summary}
                        <span className="ml-2 font-mono">{new Date(t.a.at).toLocaleString()}</span>
                      </p>
                    </li>
                  ),
                )}
              </ol>
            )}
            {canEdit && (
              <div className="mt-5 flex items-start gap-2 border-t border-line-subtle pt-4">
                <MentionInput
                  value={comment}
                  onChange={setComment}
                  onSubmit={() => void post()}
                  people={names}
                  placeholder="Add a comment… type @ to mention someone (they’ll be notified)"
                  label="Add a comment"
                />
                <Button onClick={() => void post()} disabled={!comment.trim()} loading={addComment.isPending}>
                  Comment
                </Button>
              </div>
            )}
          </Panel>
        </div>

        <aside className="space-y-4">
          <Panel title="Details">
            <div className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-label text-fg-secondary">State</span>
                <Select
                  className="w-full"
                  value={data.state}
                  disabled={!canEdit || update.isPending}
                  onChange={(e) => save({ state: e.target.value as WorkItemStateDto })}
                >
                  {STATE_ORDER.map((s) => (
                    <option key={s} value={s}>
                      {STATE_LABEL[s]}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="block">
                <span className="mb-1 block text-label text-fg-secondary">Priority</span>
                <Select
                  className="w-full"
                  value={data.priority}
                  disabled={!canEdit || update.isPending}
                  onChange={(e) => save({ priority: Number(e.target.value) })}
                >
                  {[1, 2, 3, 4, 5].map((p) => (
                    <option key={p} value={p}>
                      P{p}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="block">
                <span className="mb-1 block text-label text-fg-secondary">Assignee</span>
                <Input
                  key={data.assignee ?? ''}
                  defaultValue={data.assignee ?? ''}
                  list="cloudops-people-detail"
                  disabled={!canEdit}
                  placeholder="unassigned"
                  onBlur={(e) => e.target.value.trim() !== (data.assignee ?? '') && save({ assignee: e.target.value.trim() || null })}
                />
                <datalist id="cloudops-people-detail">
                  {names.map((n) => (
                    <option key={n} value={n} />
                  ))}
                </datalist>
              </label>
              <label className="block">
                <span className="mb-1 block text-label text-fg-secondary">Due date</span>
                <Input
                  type="date"
                  key={data.dueDate ?? ''}
                  defaultValue={data.dueDate?.slice(0, 10) ?? ''}
                  disabled={!canEdit}
                  onBlur={(e) => e.target.value !== (data.dueDate?.slice(0, 10) ?? '') && save({ dueDate: e.target.value || null })}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-label text-fg-secondary">Recurrence</span>
                <Select
                  className="w-full"
                  value={data.recurrence ?? ''}
                  disabled={!canEdit || update.isPending}
                  onChange={(e) => save({ recurrence: (e.target.value || null) as (typeof WORK_RECURRENCES)[number] | null })}
                >
                  <option value="">one-off</option>
                  {WORK_RECURRENCES.map((r) => (
                    <option key={r} value={r}>
                      {r} review
                    </option>
                  ))}
                </Select>
              </label>
            </div>
          </Panel>
          <Panel title="Record">
            <DescriptionList
              items={[
                { label: 'Created', value: new Date(data.createdAt).toLocaleString() },
                { label: 'Created by', value: data.createdBy ?? '—' },
                { label: 'Updated', value: new Date(data.updatedAt).toLocaleString() },
                { label: 'Id', value: data.id, mono: true },
              ]}
            />
          </Panel>
        </aside>
      </div>

      {editing && <WorkItemDialog item={data} onClose={() => setEditing(false)} />}
    </div>
  );
}
