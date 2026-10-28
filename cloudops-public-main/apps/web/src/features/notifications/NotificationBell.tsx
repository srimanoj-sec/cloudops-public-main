import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell, CheckCheck } from 'lucide-react';
import type { NotificationDto } from '@cloudops/core';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationsRead,
  useNotifications,
  useUnreadNotifications,
} from '../../lib/queries';
import { Spinner, TextButton, cn } from '../../components/ui/primitives';
import { NotificationRow } from './NotificationList';

/** Header bell: unread count (polled), and the latest notifications in a popover. */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const unread = useUnreadNotifications();
  const list = useNotifications({ limit: 12 }, open);
  const markRead = useMarkNotificationsRead();
  const markAll = useMarkAllNotificationsRead();
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const count = unread.data ?? 0;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function onOpen(n: NotificationDto) {
    if (!n.read) markRead.mutate([n.id]);
    setOpen(false);
  }

  return (
    <div ref={ref} className="relative">
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={count ? `Notifications, ${count} unread` : 'Notifications'}
        className="relative grid size-9 place-items-center rounded-sm text-fg-secondary transition-colors duration-150 hover:bg-hover hover:text-fg"
      >
        <Bell className="size-[18px]" aria-hidden />
        {count > 0 && (
          <span className="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 font-mono text-[10px] font-medium leading-none text-accent-fg">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 top-full z-40 mt-2 flex max-h-[70vh] w-[min(26rem,calc(100vw-2rem))] animate-pop-in flex-col rounded-md border border-line-strong bg-overlay shadow-2"
        >
          <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
            <div className="text-h4 text-fg">
              Notifications {count > 0 && <span className="ml-1 font-mono font-normal text-fg-muted">{count} unread</span>}
            </div>
            {count > 0 && (
              <TextButton onClick={() => markAll.mutate()} disabled={markAll.isPending}>
                <CheckCheck className="size-3.5" aria-hidden /> Mark all read
              </TextButton>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {list.isLoading ? (
              <div className="grid place-items-center py-10">
                <Spinner label="Loading…" />
              </div>
            ) : !list.data?.items.length ? (
              <div className="px-4 py-10 text-center">
                <p className="text-body-sm text-fg">You’re all caught up.</p>
                <p className="mt-1 text-caption text-fg-muted">
                  Failed syncs, cost anomalies, approvals, mentions and due work show up here.
                </p>
              </div>
            ) : (
              <ul className="space-y-0.5">
                {list.data.items.map((n) => (
                  <li key={n.id}>
                    <NotificationRow n={n} onOpen={onOpen} compact />
                  </li>
                ))}
              </ul>
            )}
          </div>
          <Link
            to="/notifications"
            onClick={() => setOpen(false)}
            className={cn('border-t border-line px-4 py-2.5 text-center text-body-sm text-accent transition-colors duration-150 hover:bg-hover/60')}
          >
            View all notifications
          </Link>
        </div>
      )}
    </div>
  );
}
