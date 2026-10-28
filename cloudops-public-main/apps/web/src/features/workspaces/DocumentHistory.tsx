import { useState } from 'react';
import { History, Undo2 } from 'lucide-react';
import { useDocumentRevision, useDocumentRevisions, useRestoreRevision } from '../../lib/queries';
import { usePermissions } from '../../lib/auth';
import { apiErrorMessage } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { Button, EmptyState, ErrorState, LoadingBlock, cn } from '../../components/ui/primitives';
import { useConfirm } from '../../components/ui/Dialogs';
import { useToast } from '../../components/ui/Toast';
import { renderMarkdown } from './markdown';

/** A document's earlier versions: who wrote each, when it was replaced, and restore. */
export function DocumentHistory({
  docId,
  scopeType,
  scopeId,
  onRestored,
}: {
  docId: string;
  scopeType: string;
  scopeId: string;
  onRestored: () => void;
}) {
  const revisions = useDocumentRevisions(docId);
  const [selected, setSelected] = useState<string | null>(null);
  const revision = useDocumentRevision(docId, selected);
  const restore = useRestoreRevision();
  const { can } = usePermissions();
  const confirm = useConfirm();
  const toast = useToast();

  async function doRestore() {
    if (!selected) return;
    const ok = await confirm({
      title: 'Restore this version?',
      description: 'The current version is kept in the history, so you can undo this.',
      confirmLabel: 'Restore',
    });
    if (!ok) return;
    try {
      await restore.mutateAsync({ id: docId, revisionId: selected, scopeType, scopeId });
      toast({ title: 'Version restored' });
      onRestored();
    } catch (e) {
      toast({ tone: 'danger', title: 'Couldn’t restore it', description: apiErrorMessage(e) });
    }
  }

  if (revisions.isLoading) return <LoadingBlock label="Loading history…" />;
  if (revisions.isError)
    return <ErrorState compact error={revisions.error} onRetry={() => void revisions.refetch()} />;
  if (!revisions.data?.length)
    return (
      <EmptyState
        compact
        icon={History}
        title="No earlier versions"
        description="Each save keeps the previous version here."
      />
    );

  return (
    <div className="grid min-h-[360px] gap-3 md:grid-cols-[16rem_minmax(0,1fr)]">
      <ul className="max-h-[420px] divide-y divide-line-subtle overflow-y-auto rounded-sm border border-line">
        {revisions.data.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => setSelected(r.id)}
              aria-pressed={selected === r.id}
              className={cn(
                'w-full px-3 py-2 text-left transition-colors duration-150 hover:bg-hover/60',
                selected === r.id && 'bg-hover',
              )}
            >
              <div className="truncate text-body-sm text-fg">{r.title}</div>
              <div className="text-caption text-fg-muted">
                {r.author ?? 'unknown author'} · replaced {timeAgo(r.createdAt)}
              </div>
            </button>
          </li>
        ))}
      </ul>
      <div className="min-w-0 rounded-sm border border-line-subtle bg-canvas/50">
        {!selected ? (
          <p className="p-4 text-caption text-fg-muted">Pick a version to read it.</p>
        ) : revision.isLoading ? (
          <LoadingBlock label="Loading version…" />
        ) : revision.data ? (
          <div>
            <div className="flex items-center justify-between gap-2 border-b border-line-subtle px-4 py-2">
              <span className="text-caption text-fg-muted">
                Written by {revision.data.author ?? 'unknown'} · replaced{' '}
                {new Date(revision.data.createdAt).toLocaleString()}
              </span>
              {can('docs.manage') && (
                <Button
                  size="sm"
                  variant="secondary"
                  icon={Undo2}
                  loading={restore.isPending}
                  onClick={() => void doRestore()}
                >
                  Restore
                </Button>
              )}
            </div>
            <div
              className="md-prose max-h-[380px] overflow-y-auto px-5 py-4"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(revision.data.body ?? '') }}
            />
          </div>
        ) : (
          <ErrorState compact error={revision.error} />
        )}
      </div>
    </div>
  );
}
