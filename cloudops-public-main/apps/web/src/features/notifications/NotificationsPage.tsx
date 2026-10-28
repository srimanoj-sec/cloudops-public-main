import { useEffect, useState } from 'react';
import { Bell, CheckCheck } from 'lucide-react';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_LABELS,
  type NotificationCategory,
  type NotificationDto,
} from '@cloudops/core';
import { useMarkAllNotificationsRead, useMarkNotificationsRead, useNotifications } from '../../lib/queries';
import {
  Button,
  EmptyState,
  ErrorState,
  PageHeader,
  Panel,
  SegmentedControl,
  Select,
  TableSkeleton,
} from '../../components/ui/primitives';
import { NotificationRow } from './NotificationList';

const PAGE = 40;

export function NotificationsPage() {
  const [view, setView] = useState<'all' | 'unread'>('all');
  const [category, setCategory] = useState<NotificationCategory | ''>('');
  const [before, setBefore] = useState<string | undefined>();
  const [pages, setPages] = useState<NotificationDto[]>([]);
  const list = useNotifications({ limit: PAGE, unreadOnly: view === 'unread', category: category || undefined, before });
  const markRead = useMarkNotificationsRead();
  const markAll = useMarkAllNotificationsRead();

  // Reset paging when the filter changes.
  useEffect(() => {
    setBefore(undefined);
    setPages([]);
  }, [view, category]);

  // Accumulate "load older" pages (the first page is always live).
  const items = before ? [...pages, ...(list.data?.items ?? [])] : (list.data?.items ?? []);

  function loadOlder() {
    if (!list.data?.nextCursor) return;
    setPages(items);
    setBefore(list.data.nextCursor);
  }

  return (
    <div>
      <PageHeader
        overline="Inbox"
        title="Notifications"
        subtitle="Failed syncs, unreachable organizations, cost anomalies and budgets, new high-severity findings, approvals, mentions, due work and expiring exemptions."
        actions={
          (list.data?.unread ?? 0) > 0 ? (
            <Button variant="secondary" icon={CheckCheck} onClick={() => markAll.mutate()} loading={markAll.isPending}>
              Mark all read
            </Button>
          ) : undefined
        }
      />
      <Panel className="mb-3" bodyClassName="flex flex-wrap items-center gap-2 p-3">
        <SegmentedControl
          label="Show"
          value={view}
          onChange={setView}
          options={[
            { value: 'all', label: 'All' },
            { value: 'unread', label: `Unread${list.data?.unread ? ` · ${list.data.unread}` : ''}` },
          ]}
        />
        <Select value={category} onChange={(e) => setCategory(e.target.value as NotificationCategory | '')} aria-label="Category">
          <option value="">Every category</option>
          {NOTIFICATION_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {NOTIFICATION_CATEGORY_LABELS[c]}
            </option>
          ))}
        </Select>
      </Panel>

      <Panel flush>
        {list.isLoading && !before ? (
          <TableSkeleton rows={8} cols={3} />
        ) : list.isError ? (
          <ErrorState compact error={list.error} onRetry={() => void list.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            compact
            icon={Bell}
            title={view === 'unread' ? 'Nothing unread' : 'No notifications yet'}
            description="The platform tells you here when something needs attention — you don’t have to keep pages open to find out."
          />
        ) : (
          <>
            <ul className="divide-y divide-line-subtle p-1.5">
              {items.map((n) => (
                <li key={n.id}>
                  <NotificationRow n={n} onOpen={(x) => !x.read && markRead.mutate([x.id])} />
                </li>
              ))}
            </ul>
            {list.data?.nextCursor && (
              <div className="border-t border-line-subtle p-3 text-center">
                <Button variant="ghost" size="sm" onClick={loadOlder} loading={list.isFetching}>
                  Load older
                </Button>
              </div>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}
