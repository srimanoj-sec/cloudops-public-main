import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, Send, Trash2 } from 'lucide-react';
import {
  WORK_ITEM_TYPES,
  WORK_RECURRENCES,
  type WorkItemDto,
  type WorkItemStateDto,
  type WorkScopeType,
  type WorkSourceDto,
} from '@cloudops/core';
import {
  useAddWorkComment,
  useCreateWorkItem,
  useDeleteWorkItem,
  useDirectory,
  useOrganizations,
  useResourceGroups,
  useResources,
  useSubscriptions,
  useUpdateWorkItem,
  useWorkItem,
} from '../../lib/queries';
import { usePermissions } from '../../lib/auth';
import { useOrg } from '../../lib/orgContext';
import { apiErrorMessage } from '../../lib/api';
import { shortType } from '../../lib/format';
import {
  Badge,
  Button,
  Field,
  IconButton,
  InlineError,
  Input,
  Select,
  Spinner,
  Textarea,
  cn,
  type Tone,
} from '../../components/ui/primitives';
import { Modal } from '../../components/ui/Modal';
import { useConfirm } from '../../components/ui/Dialogs';
import { useToast } from '../../components/ui/Toast';
import { MentionInput } from './MentionInput';
import { SOURCE_KIND_LABEL, sourceLink } from './source';

export const STATE_ORDER: WorkItemStateDto[] = ['todo', 'in_progress', 'blocked', 'done'];
export const STATE_LABEL: Record<WorkItemStateDto, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
};
export const STATE_TONE: Record<WorkItemStateDto, Tone> = {
  todo: 'neutral',
  in_progress: 'accent',
  blocked: 'danger',
  done: 'success',
};

export function priorityTone(p: number): 'danger' | 'warning' | 'neutral' {
  if (p <= 1) return 'danger';
  if (p === 2) return 'warning';
  return 'neutral';
}

export function isOverdue(item: WorkItemDto): boolean {
  return Boolean(item.dueDate && item.state !== 'done' && new Date(item.dueDate).getTime() < Date.now());
}

export function scopeChipLabel(link: WorkItemDto['links'][number]): string {
  const kind =
    link.scopeType === 'organization'
      ? 'org'
      : link.scopeType === 'subscription'
        ? 'sub'
        : link.scopeType === 'resourceGroup'
          ? 'rg'
          : 'res';
  return `${kind}: ${link.scopeName ?? link.scopeId.slice(0, 8)}`;
}

/** Two-letter initials for an assignee / author chip. */
export function initialsOf(name: string): string {
  const parts = name.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

export function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-5 shrink-0 place-items-center rounded-full border border-line-strong bg-raised font-mono text-[9px] font-medium text-fg-secondary',
        className,
      )}
    >
      {initialsOf(name)}
    </span>
  );
}

export interface FixedScope {
  scopeType: WorkScopeType;
  scopeId: string;
  scopeName?: string;
}

export interface WorkDefaults {
  title?: string;
  description?: string;
  type?: string;
  priority?: number;
  dueDate?: string;
}

/** The origin chip ("From: Compliance finding · Web app accepts HTTPS only"). */
export function SourceChip({ source }: { source: Pick<WorkSourceDto, 'type' | 'id' | 'label'> }) {
  const to = sourceLink(source);
  const text = `${SOURCE_KIND_LABEL[source.type] ?? source.type}${source.label ? ` · ${source.label}` : ''}`;
  return to ? (
    <Link
      to={to}
      className="inline-flex max-w-full items-center gap-1 rounded-xs border border-info/25 bg-info/10 px-1.5 py-0.5 text-caption text-info transition-colors duration-150 hover:border-info/50"
    >
      <span className="truncate">From: {text}</span>
    </Link>
  ) : (
    <Badge tone="info">From: {text}</Badge>
  );
}

/**
 * Create/edit dialog. `item` = edit mode. For a new item, `fixedScope` / `scopes`
 * pre-link it to entities, `source` records what raised it (finding, anomaly…)
 * and `defaults` pre-fill the form.
 */
export function WorkItemDialog({
  item,
  fixedScope,
  scopes,
  source,
  defaults,
  onClose,
}: {
  item?: WorkItemDto | null;
  fixedScope?: FixedScope;
  scopes?: FixedScope[];
  source?: { type: string; id: string; label?: string };
  defaults?: WorkDefaults;
  onClose: () => void;
}) {
  const { can } = usePermissions();
  const canEdit = can('work.manage');
  const editing = Boolean(item);
  const confirm = useConfirm();
  const toast = useToast();

  const create = useCreateWorkItem();
  const update = useUpdateWorkItem();
  const del = useDeleteWorkItem();
  const detail = useWorkItem(editing ? item!.id : null);
  const addComment = useAddWorkComment();

  const people = useDirectory();
  const peopleNames = (people.data ?? []).map((p) => p.name);
  const [title, setTitle] = useState(item?.title ?? defaults?.title ?? '');
  const [description, setDescription] = useState(item?.description ?? defaults?.description ?? '');
  const [type, setType] = useState(item?.type ?? defaults?.type ?? 'task');
  const [state, setState] = useState<WorkItemStateDto>(item?.state ?? 'todo');
  const [priority, setPriority] = useState(item?.priority ?? defaults?.priority ?? 3);
  const [assignee, setAssignee] = useState(item?.assignee ?? '');
  const [dueDate, setDueDate] = useState(item?.dueDate ? item.dueDate.slice(0, 10) : (defaults?.dueDate ?? ''));
  const [recurrence, setRecurrence] = useState(item?.recurrence ?? '');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [commentError, setCommentError] = useState<string | null>(null);

  // Scope picker (create only, and only when no fixedScope).
  const { tenantId } = useOrg();
  const [scopeType, setScopeType] = useState<'' | WorkScopeType>('');
  const [scopeSub, setScopeSub] = useState('');
  const [scopeRg, setScopeRg] = useState('');
  const [scopeOrg, setScopeOrg] = useState('');
  const [scopeRes, setScopeRes] = useState('');
  const [scopeResName, setScopeResName] = useState<string | undefined>();
  const [resSearch, setResSearch] = useState('');
  const orgs = useOrganizations();
  const subs = useSubscriptions();
  const rgs = useResourceGroups(scopeSub || undefined);
  // Resource picker: search the estate (org-scoped) when linking to a single resource.
  const resources = useResources({
    search: resSearch || undefined,
    tenantId: tenantId || undefined,
    pageSize: 25,
    page: 1,
  });

  const busy = create.isPending || update.isPending || del.isPending;

  function resolveScope() {
    if (fixedScope) return { scopeType: fixedScope.scopeType, scopeId: fixedScope.scopeId, scopeName: fixedScope.scopeName };
    if (scopeType === 'organization' && scopeOrg) return { scopeType, scopeId: scopeOrg };
    if (scopeType === 'subscription' && scopeSub) return { scopeType, scopeId: scopeSub };
    if (scopeType === 'resourceGroup' && scopeRg) return { scopeType, scopeId: scopeRg };
    if (scopeType === 'resource' && scopeRes) return { scopeType, scopeId: scopeRes, scopeName: scopeResName };
    return undefined;
  }

  async function save() {
    if (!title.trim()) return;
    setError(null);
    try {
      if (editing) {
        await update.mutateAsync({
          id: item!.id,
          input: {
            title: title.trim(),
            description: description || null,
            type,
            state,
            priority,
            assignee: assignee || null,
            dueDate: dueDate || null,
            recurrence: recurrence ? (recurrence as 'weekly' | 'monthly' | 'quarterly') : null,
          },
        });
      } else {
        await create.mutateAsync({
          title: title.trim(),
          description: description || undefined,
          type,
          state,
          priority,
          assignee: assignee || undefined,
          dueDate: dueDate || undefined,
          recurrence: recurrence ? (recurrence as 'weekly' | 'monthly' | 'quarterly') : undefined,
          scope: resolveScope(),
          scopes: scopes?.map((s) => ({ scopeType: s.scopeType, scopeId: s.scopeId, scopeName: s.scopeName })),
          source,
        });
      }
      toast({ title: editing ? 'Work item saved' : 'Work item created', description: title.trim() });
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  }

  async function remove() {
    if (!editing) return;
    const ok = await confirm({
      title: 'Delete this work item?',
      description: `“${item!.title}” and its comments will be permanently deleted.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    setError(null);
    try {
      await del.mutateAsync(item!.id);
      toast({ title: 'Work item deleted' });
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  }

  async function postComment() {
    if (!comment.trim()) return;
    setCommentError(null);
    try {
      await addComment.mutateAsync({ id: item!.id, body: comment.trim() });
      setComment('');
    } catch (e) {
      setCommentError(apiErrorMessage(e));
    }
  }

  const comments = detail.data?.comments ?? [];

  return (
    <Modal
      title={editing ? 'Edit work item' : 'New work item'}
      description={
        !canEdit ? (
          'Read-only — you need the “work.manage” permission to make changes.'
        ) : editing ? (
          <Link to={`/work/${item!.id}`} className="link inline-flex items-center gap-1" onClick={onClose}>
            Open the full page <ExternalLink className="size-3.5" aria-hidden />
          </Link>
        ) : undefined
      }
      onClose={onClose}
      footer={
        <>
          {editing && canEdit && (
            <Button variant="danger-ghost" icon={Trash2} className="mr-auto" onClick={remove} disabled={busy}>
              Delete
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!canEdit || busy || !title.trim()} loading={create.isPending || update.isPending}>
            {editing ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        {(source || item?.source) && (
          <div className="-mt-1">
            <SourceChip source={item?.source ?? { type: source!.type, id: source!.id, label: source!.label ?? null }} />
          </div>
        )}
        <div className="space-y-4">
          <Field label="Title" required>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" disabled={!canEdit} />
          </Field>
          <Field label="Description">
            <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} disabled={!canEdit} />
          </Field>
        </div>

        <fieldset className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3">
          <legend className="sr-only">Properties</legend>
          <Field label="Type">
            <Select className="w-full" value={type} onChange={(e) => setType(e.target.value)} disabled={!canEdit}>
              {WORK_ITEM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Priority">
            <Select className="w-full" value={priority} onChange={(e) => setPriority(Number(e.target.value))} disabled={!canEdit}>
              {[1, 2, 3, 4, 5].map((p) => (
                <option key={p} value={p}>
                  P{p}
                  {p === 1 ? ' (highest)' : p === 5 ? ' (lowest)' : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="State">
            <Select className="w-full" value={state} onChange={(e) => setState(e.target.value as WorkItemStateDto)} disabled={!canEdit}>
              {STATE_ORDER.map((s) => (
                <option key={s} value={s}>
                  {STATE_LABEL[s]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Assignee" hint={peopleNames.length ? 'Pick a person to notify them' : undefined}>
            <Input
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              placeholder="unassigned"
              disabled={!canEdit}
              list="cloudops-people"
              autoComplete="off"
            />
            <datalist id="cloudops-people">
              {peopleNames.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </Field>
          <Field label="Due date">
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} disabled={!canEdit} />
          </Field>
          <Field label="Recurrence">
            <Select className="w-full" value={recurrence} onChange={(e) => setRecurrence(e.target.value)} disabled={!canEdit}>
              <option value="">one-off</option>
              {WORK_RECURRENCES.map((r) => (
                <option key={r} value={r}>
                  {r} review
                </option>
              ))}
            </Select>
          </Field>
        </fieldset>

        {/* Scope */}
        {scopes && scopes.length > 0 ? (
          <div>
            <div className="mb-1.5 text-label text-fg-secondary">
              Linked to {scopes.length > 1 ? `${scopes.length} resources` : ''}
            </div>
            <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
              {scopes.map((s) => (
                <Badge key={`${s.scopeType}:${s.scopeId}`} tone="accent">
                  {s.scopeName ?? s.scopeId}
                </Badge>
              ))}
            </div>
          </div>
        ) : fixedScope ? (
          <div>
            <div className="mb-1.5 text-label text-fg-secondary">Linked to</div>
            <Badge tone="accent">
              {fixedScope.scopeType}: {fixedScope.scopeName ?? fixedScope.scopeId}
            </Badge>
          </div>
        ) : editing ? (
          item!.links.length > 0 && (
            <div>
              <div className="mb-1.5 text-label text-fg-secondary">Linked to</div>
              <div className="flex flex-wrap gap-1.5">
                {item!.links.map((l) => (
                  <Badge key={l.id} tone="accent">
                    {scopeChipLabel(l)}
                  </Badge>
                ))}
              </div>
            </div>
          )
        ) : (
          <fieldset className="rounded-md border border-line-subtle bg-canvas/40 px-4 pb-4 pt-2">
            <legend className="px-1 font-mono text-overline uppercase text-fg-muted">Link to</legend>
            <div className="grid grid-cols-1 gap-x-3 gap-y-4 sm:grid-cols-3">
              <Field label="Scope">
                <Select
                  className="w-full"
                  value={scopeType}
                  onChange={(e) => {
                    setScopeType(e.target.value as WorkScopeType | '');
                    setScopeSub('');
                    setScopeRg('');
                    setScopeOrg('');
                    setScopeRes('');
                    setScopeResName(undefined);
                    setResSearch('');
                  }}
                  disabled={!canEdit}
                >
                  <option value="">— nothing —</option>
                  <option value="organization">Organization</option>
                  <option value="subscription">Subscription</option>
                  <option value="resourceGroup">Resource group</option>
                  <option value="resource">Resource</option>
                </Select>
              </Field>
              {scopeType === 'organization' && (
                <Field label="Organization">
                  <Select className="w-full" value={scopeOrg} onChange={(e) => setScopeOrg(e.target.value)}>
                    <option value="">select…</option>
                    {orgs.data?.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              {(scopeType === 'subscription' || scopeType === 'resourceGroup') && (
                <Field label="Subscription">
                  <Select
                    className="w-full"
                    value={scopeSub}
                    onChange={(e) => {
                      setScopeSub(e.target.value);
                      setScopeRg('');
                    }}
                  >
                    <option value="">select…</option>
                    {subs.data?.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              {scopeType === 'resourceGroup' && (
                <Field label="Resource group">
                  <Select className="w-full" value={scopeRg} onChange={(e) => setScopeRg(e.target.value)} disabled={!scopeSub}>
                    <option value="">select…</option>
                    {rgs.data?.map((rg) => (
                      <option key={rg.id} value={rg.id}>
                        {rg.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              {scopeType === 'resource' && (
                <div className="space-y-2 sm:col-span-2">
                  <Field label={`Resource${tenantId ? ' (current org)' : ''}`}>
                    <Input value={resSearch} onChange={(e) => setResSearch(e.target.value)} placeholder="Search resources by name / type…" />
                  </Field>
                  <Select
                    className="w-full"
                    aria-label="Resource"
                    value={scopeRes}
                    onChange={(e) => {
                      setScopeRes(e.target.value);
                      setScopeResName(resources.data?.items.find((r) => r.id === e.target.value)?.name);
                    }}
                  >
                    <option value="">
                      {resources.isFetching ? 'searching…' : `select… (${resources.data?.items.length ?? 0} shown)`}
                    </option>
                    {resources.data?.items.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name} · {shortType(r.type)}
                      </option>
                    ))}
                  </Select>
                  {(resources.data?.total ?? 0) > (resources.data?.items.length ?? 0) && (
                    <p className="text-caption text-fg-muted">
                      Showing {resources.data?.items.length} of {resources.data?.total} — refine the search to narrow down.
                    </p>
                  )}
                </div>
              )}
            </div>
          </fieldset>
        )}

        {error && <InlineError>{error}</InlineError>}

        {/* Comments (edit only) */}
        {editing && (
          <section aria-label="Comments" className="border-t border-line pt-5">
            <h3 className="mb-3 flex items-center gap-2 font-mono text-overline uppercase text-fg-muted">
              Comments <span className="text-fg-faint">{comments.length}</span>
            </h3>
            {detail.isLoading ? (
              <Spinner label="Loading…" />
            ) : comments.length === 0 ? (
              <p className="text-body-sm text-fg-muted">No comments yet.</p>
            ) : (
              <ul className="space-y-3">
                {comments.map((c) => (
                  <li key={c.id} className="flex gap-3">
                    <Avatar name={c.author} className="mt-0.5 size-6" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2 text-caption">
                        <span className="font-medium text-fg-secondary">{c.author}</span>
                        <span className="font-mono text-fg-muted">{new Date(c.createdAt).toLocaleString()}</span>
                      </div>
                      <div className="mt-1 whitespace-pre-wrap rounded-sm border border-line-subtle bg-canvas/60 px-3 py-2 text-body-sm text-fg">
                        {c.body}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {canEdit && (
              <div className="mt-4 flex items-start gap-2">
                <MentionInput
                  value={comment}
                  onChange={setComment}
                  onSubmit={() => comment.trim() && void postComment()}
                  people={peopleNames}
                  placeholder="Add a comment… type @ to mention someone"
                  label="Add a comment"
                />
                <IconButton
                  icon={Send}
                  label="Post comment"
                  variant="secondary"
                  disabled={!comment.trim()}
                  loading={addComment.isPending}
                  onClick={() => void postComment()}
                />
              </div>
            )}
            {commentError && <InlineError className="mt-2">{commentError}</InlineError>}
          </section>
        )}
      </div>
    </Modal>
  );
}
