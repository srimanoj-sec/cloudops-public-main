import { useEffect, useMemo, useState } from 'react';
import { Building2, ChevronRight, FolderTree, KeyRound, Layers, Search } from 'lucide-react';
import type { InventoryTreeDto } from '@cloudops/core';
import { Input, Skeleton, cn } from '../../components/ui/primitives';

export interface ScopeSelection {
  tenantId: string;
  subscriptionId: string;
  resourceGroupId: string;
}

type Org = InventoryTreeDto['organizations'][number];
type Sub = Org['subscriptions'][number];

function Row({
  depth,
  icon: Icon,
  label,
  count,
  selected,
  expandable,
  expanded,
  onToggle,
  onSelect,
}: {
  depth: number;
  icon: typeof Building2;
  label: string;
  count: number;
  selected: boolean;
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  onSelect: () => void;
}) {
  return (
    <div
      className={cn(
        'group relative flex items-center gap-1 rounded-sm pr-2 text-body-sm transition-colors duration-150',
        selected ? 'bg-accent/10 text-fg' : 'text-fg-secondary hover:bg-hover hover:text-fg',
      )}
      style={{ paddingLeft: `${depth * 14 + 4}px` }}
    >
      {selected && <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-accent" aria-hidden />}
      {expandable ? (
        <button
          type="button"
          onClick={onToggle}
          className="focus-ring grid size-5 shrink-0 place-items-center rounded-xs text-fg-muted hover:text-fg"
          aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
          aria-expanded={expanded}
        >
          <ChevronRight className={cn('size-3.5 transition-transform duration-150', expanded && 'rotate-90')} aria-hidden />
        </button>
      ) : (
        <span className="size-5 shrink-0" />
      )}
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className="focus-ring flex min-w-0 flex-1 items-center gap-1.5 rounded-xs py-1.5 text-left"
        title={label}
      >
        <Icon className={cn('size-3.5 shrink-0', selected ? 'text-accent' : 'text-fg-muted')} aria-hidden />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="shrink-0 font-mono text-caption tabular-nums text-fg-muted">{count}</span>
      </button>
    </div>
  );
}

/**
 * Where am I? Organizations → subscriptions → resource groups, with resource
 * counts. Selecting a node scopes the inventory to it; the path to the current
 * scope stays expanded.
 */
export function ScopeTree({
  tree,
  loading,
  selection,
  onSelect,
}: {
  tree: InventoryTreeDto | undefined;
  loading: boolean;
  selection: ScopeSelection;
  onSelect: (next: ScopeSelection) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();

  // Always show the path to the current selection.
  const selectedPath = useMemo(() => {
    const ids = new Set<string>();
    for (const o of tree?.organizations ?? []) {
      for (const s of o.subscriptions) {
        const hit = s.id === selection.subscriptionId || s.resourceGroups.some((g) => g.id === selection.resourceGroupId);
        if (hit) {
          ids.add(`o:${o.id ?? ''}`);
          ids.add(`s:${s.id}`);
        }
      }
      if (o.id && o.id === selection.tenantId) ids.add(`o:${o.id}`);
    }
    return ids;
  }, [tree, selection]);

  // Selecting a scope (here, or via a link) expands the path to it.
  useEffect(() => {
    if (selectedPath.size) setOpen((prev) => new Set([...prev, ...selectedPath]));
  }, [selectedPath]);

  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const isOpen = (key: string) => Boolean(needle) || open.has(key);

  const matchSub = (s: Sub) => !needle || s.name.toLowerCase().includes(needle) || s.resourceGroups.some((g) => g.name.toLowerCase().includes(needle));
  const matchOrg = (o: Org) => !needle || o.name.toLowerCase().includes(needle) || o.subscriptions.some(matchSub);
  const total = (tree?.organizations ?? []).reduce((n, o) => n + o.count, 0);
  const nothingSelected = !selection.tenantId && !selection.subscriptionId && !selection.resourceGroupId;

  return (
    <nav aria-label="Browse by scope" className="flex max-h-[calc(100dvh-7rem)] flex-col overflow-hidden rounded-md border border-line bg-surface">
      <div className="border-b border-line-subtle p-2">
        <Input icon={Search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a subscription or group…" aria-label="Filter scopes" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {loading ? (
          <div className="space-y-2 p-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-4" />
            ))}
          </div>
        ) : (
          <>
            <Row depth={0} icon={Layers} label="All organizations" count={total} selected={nothingSelected} onSelect={() => onSelect({ tenantId: '', subscriptionId: '', resourceGroupId: '' })} />
            {(tree?.organizations ?? []).filter(matchOrg).map((o) => {
              const okey = `o:${o.id ?? ''}`;
              return (
                <div key={okey}>
                  <Row
                    depth={0}
                    icon={Building2}
                    label={o.name}
                    count={o.count}
                    selected={Boolean(o.id) && selection.tenantId === o.id && !selection.subscriptionId && !selection.resourceGroupId}
                    expandable
                    expanded={isOpen(okey)}
                    onToggle={() => toggle(okey)}
                    onSelect={() => onSelect({ tenantId: o.id ?? '', subscriptionId: '', resourceGroupId: '' })}
                  />
                  {isOpen(okey) &&
                    o.subscriptions.filter(matchSub).map((s) => {
                      const skey = `s:${s.id}`;
                      const groups = s.resourceGroups.filter((g) => !needle || g.name.toLowerCase().includes(needle) || s.name.toLowerCase().includes(needle));
                      return (
                        <div key={skey}>
                          <Row
                            depth={1}
                            icon={KeyRound}
                            label={s.name}
                            count={s.count}
                            selected={selection.subscriptionId === s.id && !selection.resourceGroupId}
                            expandable={s.resourceGroups.length > 0}
                            expanded={isOpen(skey)}
                            onToggle={() => toggle(skey)}
                            onSelect={() => onSelect({ tenantId: o.id ?? '', subscriptionId: s.id, resourceGroupId: '' })}
                          />
                          {isOpen(skey) &&
                            groups.map((g) => (
                              <Row
                                key={g.id}
                                depth={2}
                                icon={FolderTree}
                                label={g.name}
                                count={g.count}
                                selected={selection.resourceGroupId === g.id}
                                onSelect={() => onSelect({ tenantId: o.id ?? '', subscriptionId: s.id, resourceGroupId: g.id })}
                              />
                            ))}
                        </div>
                      );
                    })}
                </div>
              );
            })}
          </>
        )}
      </div>
    </nav>
  );
}
