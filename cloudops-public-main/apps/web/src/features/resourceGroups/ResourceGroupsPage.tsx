import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, FolderTree, KeyRound, Tags } from 'lucide-react';
import type { ResourceGroupDto } from '@cloudops/core';
import { useAzureWriteEnabled, useResourceGroups, useSubscriptions } from '../../lib/queries';
import { useOrg } from '../../lib/orgContext';
import { usePermissions } from '../../lib/auth';
import { dailyCost } from '../../lib/format';
import {
  Button,
  EmptyState,
  ErrorState,
  PageHeader,
  Panel,
  Select,
  Spinner,
  TableSkeleton,
  TextButton,
} from '../../components/ui/primitives';
import { ApplyRgTagsModal } from './ApplyRgTagsModal';

export function ResourceGroupsPage() {
  const { tenantId } = useOrg();
  const { can } = usePermissions();
  const canManage = can('inventory.tag');
  const writeEnabled = useAzureWriteEnabled();
  const canTag = canManage && writeEnabled;
  const [tagRg, setTagRg] = useState<ResourceGroupDto | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const subscriptionId = searchParams.get('subscriptionId') ?? '';

  // Subscription filter options — scoped to the active organization.
  const subs = useSubscriptions(tenantId || undefined);
  const rgs = useResourceGroups(subscriptionId || undefined, tenantId || undefined);

  const subName = useMemo(
    () => subs.data?.find((s) => s.id === subscriptionId)?.name,
    [subs.data, subscriptionId],
  );

  function setSubscription(id: string) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id) next.set('subscriptionId', id);
        else next.delete('subscriptionId');
        return next;
      },
      { replace: true },
    );
  }

  const subtitle = subscriptionId
    ? `Resource groups in ${subName ?? 'the selected subscription'}.`
    : 'Every resource group across your estate. Open one to see its resources.';

  return (
    <div>
      <PageHeader overline="Estate" title="Resource groups" subtitle={subtitle} />

      {/* Filter bar: subscription selector (respects the global org switcher). */}
      <Panel className="mb-3" bodyClassName="flex flex-wrap items-center gap-2 p-3">
        <Select
          icon={KeyRound}
          value={subscriptionId}
          onChange={(e) => setSubscription(e.target.value)}
          aria-label="Filter by subscription"
          selectClassName="max-w-[20rem]"
        >
          <option value="">All subscriptions</option>
          {subs.data?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        {subscriptionId && (
          <TextButton tone="muted" onClick={() => setSubscription('')}>
            Clear
          </TextButton>
        )}
        {rgs.isFetching && !rgs.isLoading && <Spinner className="ml-auto" label="Updating…" />}
      </Panel>

      <Panel
        flush
        title={
          <span className="flex items-center gap-2">
            Resource groups
            {rgs.data && (
              <span className="font-mono text-body-sm font-normal tabular-nums text-fg-muted">{rgs.data.length}</span>
            )}
          </span>
        }
      >
        {rgs.isLoading ? (
          <TableSkeleton rows={8} cols={5} />
        ) : rgs.isError ? (
          <ErrorState compact title="Couldn’t load resource groups" error={rgs.error} onRetry={() => void rgs.refetch()} retrying={rgs.isRefetching} />
        ) : !rgs.data || rgs.data.length === 0 ? (
          <EmptyState
            compact
            icon={FolderTree}
            title="No resource groups"
            description="Run an Azure sync from the dashboard, or pick a different subscription."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Resource group</th>
                  <th scope="col" className="hidden md:table-cell">
                    Location
                  </th>
                  {!subscriptionId && (
                    <th scope="col" className="hidden md:table-cell">
                      Subscription
                    </th>
                  )}
                  <th scope="col" className="num">
                    Resources
                  </th>
                  <th scope="col" className="num">
                    Daily cost
                  </th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rgs.data.map((rg) => (
                  <tr key={rg.id}>
                    <td className="max-w-[20rem] break-words">
                      <Link to={`/inventory?resourceGroupId=${rg.id}`} className="link-quiet font-medium">
                        {rg.name}
                      </Link>
                    </td>
                    <td className="hidden font-mono text-caption md:table-cell">{rg.location ?? '—'}</td>
                    {!subscriptionId && (
                      <td className="hidden whitespace-nowrap md:table-cell">
                        <button
                          type="button"
                          onClick={() => setSubscription(rg.subscriptionId ?? '')}
                          className="rounded-xs text-left text-fg-secondary transition-colors duration-150 hover:text-accent"
                          title="Filter to this subscription"
                        >
                          {rg.subscriptionName ?? '—'}
                        </button>
                      </td>
                    )}
                    <td className="num">{rg.resourceCount ?? 0}</td>
                    <td className="num text-fg">{dailyCost(rg.dailyCost, rg.costCurrency)}</td>
                    <td>
                      <span className="flex items-center justify-end gap-1">
                        {canTag && (
                          <Button
                            variant="ghost"
                            size="sm"
                            icon={Tags}
                            onClick={() => setTagRg(rg)}
                            title="Apply tags to this RG + all its resources"
                          >
                            Tags
                          </Button>
                        )}
                        <Link
                          to={`/inventory?resourceGroupId=${rg.id}`}
                          className="link inline-flex h-8 items-center gap-1 whitespace-nowrap px-2 text-body-sm"
                        >
                          View resources <ArrowRight className="size-3.5" aria-hidden />
                        </Link>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {tagRg && <ApplyRgTagsModal rg={tagRg} onClose={() => setTagRg(null)} />}
    </div>
  );
}
