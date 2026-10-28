import { useState } from 'react';
import { ChevronRight, Plus, SquareKanban } from 'lucide-react';
import type { WorkItemDto, WorkScopeType } from '@cloudops/core';
import { useWorkItems } from '../../lib/queries';
import { usePermissions } from '../../lib/auth';
import { Badge, Button, EmptyState, LoadingBlock, Panel, cn } from '../../components/ui/primitives';
import { STATE_LABEL, STATE_TONE, WorkItemDialog, isOverdue, priorityTone } from './shared';

/**
 * Tasks linked to a single entity (resource / RG / subscription / organization).
 * Drop-in for any detail page's "Tasks" tab — lists the scope's work items and
 * creates new ones pre-linked to it.
 */
export function ScopedTasks({
  scopeType,
  scopeId,
  scopeName,
}: {
  scopeType: WorkScopeType;
  scopeId: string;
  scopeName?: string;
}) {
  const { can } = usePermissions();
  const canEdit = can('work.manage');
  const items = useWorkItems({ scopeType, scopeId });
  const [dialog, setDialog] = useState<{ mode: 'new' } | { mode: 'edit'; item: WorkItemDto } | null>(null);

  const list = items.data ?? [];

  return (
    <Panel
      flush
      title={
        <span className="flex items-center gap-2">
          Tasks {list.length > 0 && <span className="font-mono font-normal text-fg-muted">{list.length}</span>}
        </span>
      }
      actions={
        canEdit && (
          <Button variant="secondary" size="sm" icon={Plus} onClick={() => setDialog({ mode: 'new' })}>
            Add task
          </Button>
        )
      }
    >
      {items.isLoading ? (
        <LoadingBlock label="Loading tasks…" />
      ) : list.length === 0 ? (
        <EmptyState
          compact
          icon={SquareKanban}
          title="No tasks linked here yet"
          description={canEdit ? 'Create one to track work against this resource.' : undefined}
        />
      ) : (
        <ul className="divide-y divide-line-subtle">
          {list.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => setDialog({ mode: 'edit', item })}
                className="focus-inset group flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-hover/50 md:px-5"
              >
                <div className="min-w-0">
                  <div className="truncate text-body-sm font-medium text-fg">{item.title}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-fg-muted">
                    <Badge tone={STATE_TONE[item.state]} dot>
                      {STATE_LABEL[item.state]}
                    </Badge>
                    <span>{item.type}</span>
                    {item.assignee && <span>· {item.assignee}</span>}
                    {item.dueDate && (
                      <span className={cn('font-mono', isOverdue(item) && 'text-danger')}>
                        · due {new Date(item.dueDate).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                </div>
                <span className="flex shrink-0 items-center gap-2">
                  <Badge tone={priorityTone(item.priority)} mono>
                    P{item.priority}
                  </Badge>
                  <ChevronRight className="size-4 text-fg-faint group-hover:text-fg-muted" aria-hidden />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {dialog?.mode === 'new' && (
        <WorkItemDialog fixedScope={{ scopeType, scopeId, scopeName }} onClose={() => setDialog(null)} />
      )}
      {dialog?.mode === 'edit' && <WorkItemDialog item={dialog.item} onClose={() => setDialog(null)} />}
    </Panel>
  );
}
