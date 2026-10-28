import { useEffect, useMemo } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowRight, Building2, CircleCheck, CircleX, PlugZap } from 'lucide-react';
import type { SubscriptionDto } from '@cloudops/core';
import { useOrganizations, useSubscriptions, useTestConnections } from '../../lib/queries';
import { useOrg } from '../../lib/orgContext';
import { dailyCost } from '../../lib/format';
import { apiErrorMessage } from '../../lib/api';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  MonoId,
  PageHeader,
  Panel,
  Skeleton,
} from '../../components/ui/primitives';

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="min-w-[5.5rem]">
      <div className="font-mono text-readout-sm tabular-nums text-fg">{value}</div>
      <div className="mt-0.5 text-caption text-fg-muted">{label}</div>
    </div>
  );
}

function subStateTone(state: string | null): 'success' | 'warning' | 'neutral' {
  if (state === 'Enabled') return 'success';
  if (!state) return 'neutral';
  return 'warning';
}

function OrgsSkeleton() {
  return (
    <div className="space-y-4" role="status" aria-label="Loading organizations">
      {Array.from({ length: 2 }).map((_, i) => (
        <div key={i} className="rounded-md border border-line bg-surface p-5">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="mt-2 h-3 w-72" />
          <div className="mt-6 space-y-3">
            {Array.from({ length: 3 }).map((__, j) => (
              <Skeleton key={j} className="h-4" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function OrganizationsPage() {
  const { tenantId } = useOrg();
  const orgs = useOrganizations(tenantId || undefined);
  const subs = useSubscriptions(tenantId || undefined);
  const test = useTestConnections('azure');

  // Group subscriptions under their organization (Tenant) for drilldown.
  const subsByTenant = useMemo(() => {
    const map = new Map<string, SubscriptionDto[]>();
    for (const s of subs.data ?? []) {
      if (!s.tenantId) continue;
      const list = map.get(s.tenantId) ?? [];
      list.push(s);
      map.set(s.tenantId, list);
    }
    return map;
  }, [subs.data]);

  const loading = orgs.isLoading || subs.isLoading;

  // Deep link `/organizations#<id>`: bring that organization into view once it has rendered.
  const { hash } = useLocation();
  const target = hash.slice(1);
  useEffect(() => {
    if (!target || loading) return;
    requestAnimationFrame(() =>
      document.getElementById(`org-${target}`)?.scrollIntoView({ block: 'start' }),
    );
  }, [target, loading]);

  return (
    <div>
      <PageHeader
        overline="Estate"
        title="Organizations"
        subtitle="Every Entra tenant discovered via its service principal — with its subscriptions, resource groups, and resources. Served from the local cache."
        actions={
          <Button
            variant="secondary"
            icon={PlugZap}
            onClick={() => test.mutate()}
            loading={test.isPending}
          >
            {test.isPending ? 'Testing…' : 'Test connectivity'}
          </Button>
        }
      />

      {test.isError && (
        <Alert tone="danger" title="Connectivity test failed" className="mb-6">
          {apiErrorMessage(test.error)}
        </Alert>
      )}

      {test.data && (
        <Panel
          className="mb-6 animate-fade-in"
          title="Service-principal read access"
          actions={
            <Badge tone={test.data.ok ? 'success' : 'danger'} dot>
              {test.data.ok ? 'All reachable' : 'Issues found'}
            </Badge>
          }
        >
          <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {test.data.accounts.map((a) => (
              <li
                key={a.account}
                className="flex items-start justify-between gap-3 rounded-sm border border-line-subtle bg-canvas/50 px-3 py-2.5"
              >
                <div className="flex min-w-0 gap-2.5">
                  {a.ok ? (
                    <CircleCheck className="mt-0.5 size-4 text-success" aria-label="Reachable" />
                  ) : (
                    <CircleX className="mt-0.5 size-4 text-danger" aria-label="Failed" />
                  )}
                  <div className="min-w-0">
                    <div className="truncate text-body-sm text-fg">{a.account}</div>
                    <div className="truncate text-caption text-fg-muted" title={a.message}>
                      {a.message}
                    </div>
                  </div>
                </div>
                <Badge tone={a.ok ? 'success' : 'danger'} mono>
                  {a.ok ? `${a.subscriptions ?? 0} subs` : 'failed'}
                </Badge>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {loading ? (
        <OrgsSkeleton />
      ) : orgs.isError ? (
        <ErrorState
          title="Couldn’t load organizations"
          error={orgs.error}
          onRetry={() => void orgs.refetch()}
          retrying={orgs.isRefetching}
        />
      ) : !orgs.data || orgs.data.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="No organizations yet"
          description="Add a service principal per org on the Providers page, then run an Azure sync from the dashboard. Each org appears here with its subscriptions."
          action={
            <Link to="/providers" className="link inline-flex items-center gap-1 text-body-sm">
              Go to Providers <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          }
        />
      ) : (
        <div className="space-y-6">
          {orgs.data.map((org) => {
            const orgSubs = subsByTenant.get(org.id) ?? [];
            return (
              <section
                key={org.id}
                id={`org-${org.id}`}
                aria-label={org.name}
                className={
                  target === org.id
                    ? 'scroll-mt-4 overflow-hidden rounded-md border border-accent/50 bg-surface ring-1 ring-accent/30'
                    : 'scroll-mt-4 overflow-hidden rounded-md border border-line bg-surface'
                }
              >
                <header className="flex flex-col gap-5 p-4 md:p-5 xl:flex-row xl:items-center xl:justify-between">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-sm border border-line bg-raised">
                      <Building2 className="size-[18px] text-accent" aria-hidden />
                    </span>
                    <div className="min-w-0">
                      <h2 className="truncate text-h3 text-fg">{org.name}</h2>
                      <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                        <span className="font-mono text-overline uppercase text-fg-faint">
                          tenant
                        </span>
                        <MonoId value={org.externalId} truncate />
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
                    <Stat label="Subscriptions" value={org.subscriptionCount} />
                    <Stat label="Resource groups" value={org.resourceGroupCount} />
                    <Stat label="Resources" value={org.resourceCount} />
                    <div>
                      <div className="font-mono text-body-sm tabular-nums text-fg-secondary">
                        {org.lastSyncedAt ? new Date(org.lastSyncedAt).toLocaleString() : 'never'}
                      </div>
                      <div className="mt-0.5 text-caption text-fg-muted">Last synced</div>
                    </div>
                  </div>
                </header>

                {orgSubs.length > 0 && (
                  <div className="overflow-x-auto border-t border-line">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th scope="col">Subscription</th>
                          <th scope="col">State</th>
                          <th scope="col" className="num">
                            Resource groups
                          </th>
                          <th scope="col" className="num">
                            Resources
                          </th>
                          <th scope="col" className="num">
                            Daily cost
                          </th>
                          <th scope="col" className="hidden lg:table-cell">
                            Subscription ID
                          </th>
                          <th scope="col">
                            <span className="sr-only">Actions</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {orgSubs.map((s) => (
                          <tr key={s.id}>
                            <td>
                              <Link
                                to={`/resource-groups?subscriptionId=${s.id}`}
                                className="link-quiet font-medium"
                              >
                                {s.name}
                              </Link>
                            </td>
                            <td>
                              <Badge tone={subStateTone(s.state)} dot>
                                {s.state ?? 'unknown'}
                              </Badge>
                            </td>
                            <td className="num">
                              <Link to={`/resource-groups?subscriptionId=${s.id}`} className="link">
                                {s.resourceGroupCount ?? 0}
                              </Link>
                            </td>
                            <td className="num">
                              <Link to={`/inventory?subscriptionId=${s.id}`} className="link">
                                {s.resourceCount ?? 0}
                              </Link>
                            </td>
                            <td className="num text-fg">
                              {dailyCost(s.dailyCost, s.costCurrency)}
                            </td>
                            <td className="hidden lg:table-cell">
                              <MonoId value={s.externalId} />
                            </td>
                            <td className="text-right">
                              <Link
                                to={`/inventory?subscriptionId=${s.id}`}
                                className="link inline-flex items-center gap-1 whitespace-nowrap text-body-sm"
                              >
                                View resources <ArrowRight className="size-3.5" aria-hidden />
                              </Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
