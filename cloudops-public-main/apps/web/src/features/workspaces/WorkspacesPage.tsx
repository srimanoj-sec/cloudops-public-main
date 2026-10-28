import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BookText, FolderOpen } from 'lucide-react';
import type { WorkspaceScopeType } from '@cloudops/core';
import {
  useOrganizations,
  useResourceGroups,
  useSubscriptions,
  useWorkspaces,
} from '../../lib/queries';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  PageHeader,
  Panel,
  Select,
  Skeleton,
  cn,
} from '../../components/ui/primitives';
import { ScopedDocs } from './ScopedDocs';

interface ActiveScope {
  scopeType: string;
  scopeId: string;
  scopeName: string | null;
}

const SCOPE_BADGE: Record<string, string> = {
  organization: 'org',
  subscription: 'sub',
  resourceGroup: 'rg',
  resource: 'resource',
};

export function WorkspacesPage() {
  const workspaces = useWorkspaces();
  const orgs = useOrganizations();
  const subs = useSubscriptions();

  // Deep link: /workspaces?scopeType=…&scopeId=…&doc=… opens that scope (and document).
  const [params] = useSearchParams();
  const linkedType = params.get('scopeType');
  const linkedId = params.get('scopeId');
  const [active, setActive] = useState<ActiveScope | null>(() =>
    linkedType && linkedId ? { scopeType: linkedType, scopeId: linkedId, scopeName: null } : null,
  );
  const linkedName = workspaces.data?.find(
    (w) => w.scopeType === active?.scopeType && w.scopeId === active?.scopeId,
  )?.scopeName;

  // New-workspace scope picker.
  const [pickType, setPickType] = useState<'' | Exclude<WorkspaceScopeType, 'resource'>>('');
  const [pickSub, setPickSub] = useState('');
  const [pickId, setPickId] = useState('');
  const rgs = useResourceGroups(pickSub || undefined);

  function openPicked() {
    if (pickType === 'organization' && pickId) {
      const o = orgs.data?.find((x) => x.id === pickId);
      if (o) setActive({ scopeType: 'organization', scopeId: o.id, scopeName: o.name });
    } else if (pickType === 'subscription' && pickSub) {
      const s = subs.data?.find((x) => x.id === pickSub);
      if (s) setActive({ scopeType: 'subscription', scopeId: s.id, scopeName: s.name });
    } else if (pickType === 'resourceGroup' && pickId) {
      const rg = rgs.data?.find((x) => x.id === pickId);
      if (rg) setActive({ scopeType: 'resourceGroup', scopeId: rg.id, scopeName: rg.name });
    }
  }

  const canOpen =
    pickType !== '' && (pickType === 'subscription' ? Boolean(pickSub) : Boolean(pickId));

  return (
    <div>
      <PageHeader
        overline="Work"
        title="Workspaces"
        subtitle="Per-scope documentation, runbooks, and SOPs — Markdown docs attached to any organization, subscription, resource group, or resource."
      />

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <div className="space-y-4">
          {/* Open a scope's workspace */}
          <Panel
            title="Open a workspace"
            description="Resource docs open from a resource’s Docs tab."
          >
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                openPicked();
              }}
            >
              <Field label="Scope">
                <Select
                  className="w-full"
                  value={pickType}
                  onChange={(e) => {
                    setPickType(e.target.value as Exclude<WorkspaceScopeType, 'resource'> | '');
                    setPickSub('');
                    setPickId('');
                  }}
                >
                  <option value="">choose scope…</option>
                  <option value="organization">Organization</option>
                  <option value="subscription">Subscription</option>
                  <option value="resourceGroup">Resource group</option>
                </Select>
              </Field>
              {pickType === 'organization' && (
                <Field label="Organization">
                  <Select
                    className="w-full"
                    value={pickId}
                    onChange={(e) => setPickId(e.target.value)}
                  >
                    <option value="">select…</option>
                    {orgs.data?.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              {(pickType === 'subscription' || pickType === 'resourceGroup') && (
                <Field label="Subscription">
                  <Select
                    className="w-full"
                    value={pickSub}
                    onChange={(e) => {
                      setPickSub(e.target.value);
                      setPickId('');
                    }}
                  >
                    <option value="">select subscription…</option>
                    {subs.data?.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              {pickType === 'resourceGroup' && (
                <Field label="Resource group">
                  <Select
                    className="w-full"
                    value={pickId}
                    onChange={(e) => setPickId(e.target.value)}
                    disabled={!pickSub}
                  >
                    <option value="">select resource group…</option>
                    {rgs.data?.map((rg) => (
                      <option key={rg.id} value={rg.id}>
                        {rg.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <Button type="submit" icon={FolderOpen} className="w-full" disabled={!canOpen}>
                Open workspace
              </Button>
            </form>
          </Panel>

          {/* Existing workspaces index */}
          <Panel
            flush
            title={
              <span className="flex items-center gap-2">
                All workspaces
                {workspaces.data && (
                  <span className="font-mono font-normal text-fg-muted">
                    {workspaces.data.length}
                  </span>
                )}
              </span>
            }
          >
            {workspaces.isLoading ? (
              <div className="space-y-3 p-4" role="status" aria-label="Loading workspaces">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-10" />
                ))}
              </div>
            ) : workspaces.isError ? (
              <ErrorState
                compact
                error={workspaces.error}
                onRetry={() => void workspaces.refetch()}
              />
            ) : !workspaces.data || workspaces.data.length === 0 ? (
              <p className="px-4 py-8 text-center text-body-sm text-fg-muted">
                No workspaces yet. Open a scope above or add a doc from a resource.
              </p>
            ) : (
              <ul className="divide-y divide-line-subtle">
                {workspaces.data.map((w) => {
                  const isActive =
                    active?.scopeType === w.scopeType && active?.scopeId === w.scopeId;
                  return (
                    <li key={w.id}>
                      <button
                        type="button"
                        aria-current={isActive || undefined}
                        onClick={() =>
                          setActive({
                            scopeType: w.scopeType,
                            scopeId: w.scopeId,
                            scopeName: w.scopeName ?? w.title,
                          })
                        }
                        className={cn(
                          'focus-inset relative w-full px-4 py-3 text-left transition-colors duration-150',
                          isActive ? 'bg-raised' : 'hover:bg-hover/50',
                        )}
                      >
                        <span
                          aria-hidden
                          className={cn(
                            'absolute bottom-2 left-0 top-2 w-[3px] rounded-r-full bg-accent',
                            !isActive && 'hidden',
                          )}
                        />
                        <span className="flex items-center justify-between gap-2">
                          <span
                            className={cn(
                              'truncate text-body-sm font-medium',
                              isActive ? 'text-fg' : 'text-fg-secondary',
                            )}
                          >
                            {w.scopeName ?? w.title}
                          </span>
                          <Badge mono>{SCOPE_BADGE[w.scopeType] ?? w.scopeType}</Badge>
                        </span>
                        <span className="mt-1 block font-mono text-caption text-fg-muted">
                          {w.documentCount} doc{w.documentCount === 1 ? '' : 's'} ·{' '}
                          {new Date(w.updatedAt).toLocaleDateString()}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </div>

        {/* Active workspace docs */}
        <div className="min-w-0">
          {active ? (
            <ScopedDocs
              key={`${active.scopeType}:${active.scopeId}`}
              scopeType={active.scopeType}
              scopeId={active.scopeId}
              scopeName={active.scopeName ?? linkedName}
              openDocId={
                active.scopeType === linkedType && active.scopeId === linkedId
                  ? params.get('doc')
                  : null
              }
            />
          ) : (
            <EmptyState
              icon={BookText}
              title="Select a workspace"
              description="Open a scope or pick a workspace from the list to view and edit its documents."
            />
          )}
        </div>
      </div>
    </div>
  );
}
