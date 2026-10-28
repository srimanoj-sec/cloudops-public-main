import { Link } from 'react-router-dom';
import {
  Bot,
  CircleDollarSign,
  RefreshCw,
  ServerCog,
  ShieldCheck,
  SquareKanban,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { NotificationCategory, NotificationDto, NotificationSeverity } from '@cloudops/core';
import { timeAgo } from '../../lib/format';
import { cn, type Tone } from '../../components/ui/primitives';

export const CATEGORY_ICON: Record<NotificationCategory, LucideIcon> = {
  sync: RefreshCw,
  cost: CircleDollarSign,
  compliance: ShieldCheck,
  work: SquareKanban,
  remediation: Wrench,
  automation: Bot,
  system: ServerCog,
};

export const SEVERITY_TONE: Record<NotificationSeverity, Tone> = {
  critical: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
  info: 'info',
};

const TONE_TEXT: Record<Tone, string> = {
  danger: 'text-danger',
  warning: 'text-warning',
  neutral: 'text-fg-muted',
  info: 'text-info',
  success: 'text-success',
  accent: 'text-accent',
};

/** One notification row — used by the header popover and the inbox page. */
export function NotificationRow({
  n,
  onOpen,
  compact,
}: {
  n: NotificationDto;
  onOpen: (n: NotificationDto) => void;
  compact?: boolean;
}) {
  const Icon = CATEGORY_ICON[n.category] ?? ServerCog;
  const tone = SEVERITY_TONE[n.severity] ?? 'neutral';
  const body = (
    <>
      <span className={cn('mt-0.5 grid size-7 shrink-0 place-items-center rounded-sm border border-line bg-raised', TONE_TEXT[tone])}>
        <Icon className="size-3.5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-start justify-between gap-2">
          <span className={cn('min-w-0 text-body-sm', n.read ? 'text-fg-secondary' : 'font-medium text-fg')}>{n.title}</span>
          <span className="shrink-0 whitespace-nowrap font-mono text-caption text-fg-muted">{timeAgo(n.createdAt)}</span>
        </span>
        {n.body && <span className={cn('mt-0.5 block text-caption text-fg-muted', compact && 'line-clamp-2')}>{n.body}</span>}
        {n.personal && <span className="mt-1 inline-block font-mono text-overline uppercase text-accent/90">for you</span>}
      </span>
      {!n.read && <span aria-label="unread" className="mt-2 size-2 shrink-0 rounded-full bg-accent" />}
    </>
  );
  const cls = cn(
    'focus-inset flex w-full gap-3 rounded-sm px-3 py-2.5 text-left transition-colors duration-150 hover:bg-hover/60',
    !n.read && 'bg-accent/[0.03]',
  );
  return n.link ? (
    <Link to={n.link} className={cls} onClick={() => onOpen(n)}>
      {body}
    </Link>
  ) : (
    <button type="button" className={cls} onClick={() => onOpen(n)}>
      {body}
    </button>
  );
}
