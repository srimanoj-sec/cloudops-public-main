import { useState } from 'react';
import { CircleCheck, Copy, GitMerge } from 'lucide-react';
import { useDuplicateResources, useMergeDuplicateResources } from '../../lib/queries';
import { apiErrorMessage } from '../../lib/api';
import { shortType } from '../../lib/format';
import { Alert, Badge, Button, LoadingBlock, Panel } from '../../components/ui/primitives';
import { Modal } from '../../components/ui/Modal';
import { useConfirm } from '../../components/ui/Dialogs';
import { useToast } from '../../components/ui/Toast';

/**
 * Data integrity: the same Azure resource stored as more than one row (its id
 * came back in different letter case before matching became case-insensitive).
 * Shows exactly what a merge moves and removes, and runs only when asked.
 */
export function DuplicatesPanel() {
  const dup = useDuplicateResources();
  const merge = useMergeDuplicateResources();
  const confirm = useConfirm();
  const toast = useToast();
  const [reviewing, setReviewing] = useState(false);
  const d = dup.data;

  async function run() {
    const ok = await confirm({
      title: `Merge ${d?.rowsToRemove ?? 0} duplicate row(s)?`,
      description:
        'For each resource, the active row is kept. Cost, change history, lifecycle events, relationships, links, docs and exemptions move onto it, then the extra rows are deleted. This can’t be undone — back up the database first if you want a way back.',
      confirmLabel: 'Merge duplicates',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      const r = await merge.mutateAsync();
      setReviewing(false);
      toast({ title: 'Duplicates merged', description: `${r.rowsRemoved} row(s) folded into ${r.groups} resource(s). Cost figures were recomputed.` });
    } catch (e) {
      toast({ tone: 'danger', title: 'Merge failed', description: apiErrorMessage(e) });
    }
  }

  return (
    <Panel title="Data integrity" description="Duplicate resource records (same Azure resource, different id letter-case)">
      {dup.isLoading ? (
        <LoadingBlock label="Checking…" />
      ) : !d || d.groups.length === 0 ? (
        <p className="flex items-center gap-2 text-body-sm text-success">
          <CircleCheck className="size-4" aria-hidden /> No duplicate resource records.
        </p>
      ) : (
        <Alert
          tone="warning"
          icon={Copy}
          title={`${d.groups.length} resource(s) are stored more than once`}
          action={
            <Button variant="secondary" size="sm" onClick={() => setReviewing(true)}>
              Review & merge
            </Button>
          }
        >
          Their cost and history are split across the copies (usually one active, one “deleted”), so they can show no cost and phantom deletions. New syncs no longer create duplicates.
        </Alert>
      )}

      {reviewing && d && (
        <Modal
          size="lg"
          title="Duplicate resource records"
          description="The first row of each group is kept; the rest merge into it."
          onClose={() => setReviewing(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setReviewing(false)}>
                Close
              </Button>
              <Button variant="danger" icon={GitMerge} onClick={() => void run()} loading={merge.isPending}>
                Merge {d.rowsToRemove} row(s)
              </Button>
            </>
          }
        >
          <ul className="-mx-5 -my-5 divide-y divide-line-subtle">
            {d.groups.map((g) => (
              <li key={g.key} className="px-5 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-fg">{g.keep.name}</span>
                  <span className="text-caption text-fg-muted">{shortType(g.keep.type)}</span>
                  <Badge tone={g.keep.state === 'active' ? 'success' : 'neutral'}>keep · {g.keep.state}</Badge>
                </div>
                <ul className="mt-1.5 space-y-1">
                  {g.remove.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-caption text-fg-muted">
                      <span className="font-mono text-fg-secondary" title={r.externalId}>
                        {r.name}
                      </span>
                      <Badge>{r.state}</Badge>
                      <span>moves {r.costRecords} cost record(s) · {r.changeEvents} change event(s)</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </Panel>
  );
}
