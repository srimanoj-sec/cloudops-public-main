import { useState } from 'react';
import { ChevronRight, FilePlus2, FileText, Trash2 } from 'lucide-react';
import {
  DOCUMENT_KINDS,
  DOCUMENT_TEMPLATES,
  type DocumentDto,
  type DocumentKind,
} from '@cloudops/core';
import { DocumentHistory } from './DocumentHistory';
import {
  useCreateDocument,
  useDeleteDocument,
  useScopeWorkspace,
  useUpdateDocument,
} from '../../lib/queries';
import { usePermissions } from '../../lib/auth';
import { apiErrorMessage } from '../../lib/api';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  InlineError,
  Input,
  LoadingBlock,
  Panel,
  SegmentedControl,
  Select,
  Textarea,
  type Tone,
} from '../../components/ui/primitives';
import { Modal } from '../../components/ui/Modal';
import { useConfirm } from '../../components/ui/Dialogs';
import { useToast } from '../../components/ui/Toast';
import { renderMarkdown } from './markdown';

function kindTone(kind: string): Tone {
  return kind === 'runbook'
    ? 'success'
    : kind === 'sop'
      ? 'warning'
      : kind === 'knowledge'
        ? 'info'
        : 'neutral';
}

function DocumentDialog({
  scopeType,
  scopeId,
  doc,
  onClose,
}: {
  scopeType: string;
  scopeId: string;
  doc?: DocumentDto | null;
  onClose: () => void;
}) {
  const { can } = usePermissions();
  const canEdit = can('docs.manage');
  const editing = Boolean(doc);
  const confirm = useConfirm();
  const toast = useToast();
  const create = useCreateDocument();
  const update = useUpdateDocument();
  const del = useDeleteDocument();

  const [title, setTitle] = useState(doc?.title ?? '');
  const [kind, setKind] = useState<DocumentKind>((doc?.kind as DocumentKind) ?? 'doc');
  const [body, setBody] = useState(doc?.body ?? '');
  const [mode, setMode] = useState<'write' | 'preview' | 'history'>(editing ? 'preview' : 'write');

  function applyTemplate(key: string) {
    const t = DOCUMENT_TEMPLATES.find((x) => x.key === key);
    if (!t) return;
    setKind(t.kind);
    if (!title.trim()) setTitle(t.title);
    setBody(t.body);
    setMode('write');
  }
  const [error, setError] = useState<string | null>(null);
  const busy = create.isPending || update.isPending || del.isPending;

  async function save() {
    if (!title.trim()) return;
    setError(null);
    try {
      if (editing) {
        await update.mutateAsync({
          id: doc!.id,
          scopeType,
          scopeId,
          input: { title: title.trim(), kind, body },
        });
      } else {
        await create.mutateAsync({
          scopeType,
          scopeId,
          input: { title: title.trim(), kind, body },
        });
      }
      toast({ title: editing ? 'Document saved' : 'Document created', description: title.trim() });
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  }

  async function remove() {
    if (!editing) return;
    const ok = await confirm({
      title: 'Delete this document?',
      description: `“${doc!.title}” will be permanently deleted.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    setError(null);
    try {
      await del.mutateAsync({ id: doc!.id, scopeType, scopeId });
      toast({ title: 'Document deleted' });
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  }

  return (
    <Modal
      wide
      title={editing ? 'Edit document' : 'New document'}
      description={
        !canEdit ? 'Read-only — sign in as an operator or admin to make changes.' : undefined
      }
      onClose={onClose}
      footer={
        <>
          {editing && canEdit && (
            <Button
              variant="danger-ghost"
              icon={Trash2}
              className="mr-auto"
              onClick={remove}
              disabled={busy}
            >
              Delete
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={save}
            disabled={!canEdit || busy || !title.trim()}
            loading={create.isPending || update.isPending}
          >
            {editing ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {editing && (doc!.updatedBy || doc!.createdBy) && (
          <p className="-mt-1 text-caption text-fg-muted">
            Last edited by {doc!.updatedBy ?? doc!.createdBy} ·{' '}
            {new Date(doc!.updatedAt).toLocaleString()}
            {doc!.createdBy && doc!.createdBy !== (doc!.updatedBy ?? doc!.createdBy)
              ? ` · created by ${doc!.createdBy}`
              : ''}
          </p>
        )}
        {!editing && canEdit && (
          <Field label="Start from" hint="A template fills in the sections; write the specifics.">
            <Select defaultValue="" onChange={(e) => applyTemplate(e.target.value)}>
              <option value="">Blank document</option>
              {DOCUMENT_TEMPLATES.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
          <Field label="Title" required>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Document title"
              disabled={!canEdit}
            />
          </Field>
          <Field label="Kind">
            <Select
              className="w-full"
              value={kind}
              onChange={(e) => setKind(e.target.value as DocumentKind)}
              disabled={!canEdit}
            >
              {DOCUMENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="flex items-center justify-between gap-2">
          <SegmentedControl
            label="Editor mode"
            size="sm"
            options={[
              { value: 'write', label: 'Write' },
              { value: 'preview', label: 'Preview' },
              ...(editing ? [{ value: 'history' as const, label: 'History' }] : []),
            ]}
            value={mode}
            onChange={setMode}
          />
          <span className="font-mono text-overline uppercase text-fg-faint">Markdown</span>
        </div>

        {mode === 'history' && editing ? (
          <DocumentHistory
            docId={doc!.id}
            scopeType={scopeType}
            scopeId={scopeId}
            onRestored={onClose}
          />
        ) : mode === 'write' ? (
          <Textarea
            className="min-h-[360px] font-mono text-body-sm"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            aria-label="Document body (Markdown)"
            placeholder={
              '# Heading\n\nWrite runbooks, SOPs, and notes in **Markdown**.\n\n- step one\n- step two'
            }
            disabled={!canEdit}
          />
        ) : (
          <div
            className="md-prose min-h-[360px] rounded-sm border border-line-subtle bg-canvas/50 px-5 py-4"
            dangerouslySetInnerHTML={{
              __html: body.trim()
                ? renderMarkdown(body)
                : '<p style="opacity:.6">Nothing to preview.</p>',
            }}
          />
        )}
        {error && <InlineError>{error}</InlineError>}
      </div>
    </Modal>
  );
}

/**
 * The documents surface for one scope (resource / RG / subscription / org).
 * Drop-in for any detail page's "Docs" tab, and reused by the Workspaces page.
 */
export function ScopedDocs({
  scopeType,
  scopeId,
  scopeName,
  openDocId,
}: {
  scopeType: string;
  scopeId: string;
  scopeName?: string | null;
  /** Open this document once the workspace loads (deep link `?doc=`). */
  openDocId?: string | null;
}) {
  const { can } = usePermissions();
  const canEdit = can('docs.manage');
  const ws = useScopeWorkspace(scopeType, scopeId);
  const [dialog, setDialog] = useState<{ mode: 'new' } | { mode: 'edit'; doc: DocumentDto } | null>(
    null,
  );

  const docs = ws.data?.workspace?.documents ?? [];
  const [openedLink, setOpenedLink] = useState<string | null>(null);
  const linked = openDocId ? docs.find((d) => d.id === openDocId) : undefined;
  if (linked && openedLink !== linked.id) {
    setOpenedLink(linked.id);
    setDialog({ mode: 'edit', doc: linked });
  }

  return (
    <Panel
      flush
      title={
        <span className="flex items-center gap-2">
          Documents{' '}
          {docs.length > 0 && (
            <span className="font-mono font-normal text-fg-muted">{docs.length}</span>
          )}
        </span>
      }
      description={scopeName ?? undefined}
      actions={
        canEdit && (
          <Button
            variant="secondary"
            size="sm"
            icon={FilePlus2}
            onClick={() => setDialog({ mode: 'new' })}
          >
            New document
          </Button>
        )
      }
    >
      {ws.isLoading ? (
        <LoadingBlock label="Loading docs…" />
      ) : docs.length === 0 ? (
        <EmptyState
          compact
          icon={FileText}
          title="No documents yet"
          description={canEdit ? 'Add a runbook, SOP, or note to document this scope.' : undefined}
        />
      ) : (
        <ul className="divide-y divide-line-subtle">
          {docs.map((d) => (
            <li key={d.id}>
              <button
                type="button"
                onClick={() => setDialog({ mode: 'edit', doc: d })}
                className="focus-inset group flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-hover/50 md:px-5"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <FileText className="size-4 text-fg-muted group-hover:text-accent" aria-hidden />
                  <span className="min-w-0">
                    <span className="block truncate text-body-sm font-medium text-fg">
                      {d.title}
                    </span>
                    <span className="block font-mono text-caption text-fg-muted">
                      edited {new Date(d.updatedAt).toLocaleString()}
                    </span>
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <Badge tone={kindTone(d.kind)}>{d.kind}</Badge>
                  <ChevronRight
                    className="size-4 text-fg-faint group-hover:text-fg-muted"
                    aria-hidden
                  />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {dialog?.mode === 'new' && (
        <DocumentDialog scopeType={scopeType} scopeId={scopeId} onClose={() => setDialog(null)} />
      )}
      {dialog?.mode === 'edit' && (
        <DocumentDialog
          scopeType={scopeType}
          scopeId={scopeId}
          doc={dialog.doc}
          onClose={() => setDialog(null)}
        />
      )}
    </Panel>
  );
}
