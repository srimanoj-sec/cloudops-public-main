import type { ReactNode } from 'react';
import axios from 'axios';
import {
  CircleAlert,
  CircleCheck,
  CloudOff,
  Info,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { apiErrorMessage } from '../../lib/api';
import { Button } from './Button';
import { cn } from './cn';

/* ── Spinner ───────────────────────────────────────────────────────────────── */

export function Spinner({ label, className }: { label?: string; className?: string }) {
  return (
    <span role="status" className={cn('inline-flex items-center gap-2 text-body-sm text-fg-muted', className)}>
      <LoaderCircle className="size-4 animate-spin text-accent" aria-hidden />
      {label ? <span>{label}</span> : <span className="sr-only">Loading</span>}
    </span>
  );
}

/** Centered loading block for a whole section. */
export function LoadingBlock({ label = 'Loading…', className }: { label?: string; className?: string }) {
  return (
    <div className={cn('grid min-h-[12rem] place-items-center', className)}>
      <Spinner label={label} />
    </div>
  );
}

/* ── Skeleton ──────────────────────────────────────────────────────────────── */

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('skeleton h-4', className)} />;
}

/** Table-shaped placeholder while rows load (keeps layout from jumping). */
export function TableSkeleton({ rows = 8, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div role="status" aria-label="Loading" className="divide-y divide-line-subtle">
      <div className="flex gap-6 bg-raised/60 px-4 py-2.5">
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} className="h-3 flex-1 opacity-60" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-6 px-4 py-3">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className={cn('h-3.5 flex-1', c === 0 && 'max-w-[14rem] flex-[2]')} />
          ))}
        </div>
      ))}
    </div>
  );
}

/* ── Alert / callout ───────────────────────────────────────────────────────── */

export type AlertTone = 'info' | 'success' | 'warning' | 'danger';

const ALERT_TONES: Record<AlertTone, { box: string; icon: string; Icon: LucideIcon }> = {
  info: { box: 'border-info/25 bg-info/[0.07]', icon: 'text-info', Icon: Info },
  success: { box: 'border-success/25 bg-success/[0.07]', icon: 'text-success', Icon: CircleCheck },
  warning: { box: 'border-warning/30 bg-warning/[0.07]', icon: 'text-warning', Icon: TriangleAlert },
  danger: { box: 'border-danger/30 bg-danger/[0.07]', icon: 'text-danger', Icon: CircleAlert },
};

export function Alert({
  tone = 'info',
  title,
  children,
  action,
  className,
  icon,
}: {
  tone?: AlertTone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
  icon?: LucideIcon;
}) {
  const t = ALERT_TONES[tone];
  const Icon = icon ?? t.Icon;
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'flex flex-col gap-3 rounded-md border px-4 py-3 sm:flex-row sm:items-center',
        t.box,
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <Icon className={cn('mt-0.5 size-4', t.icon)} aria-hidden />
        <div className="min-w-0 text-body-sm">
          {title && <div className="font-medium text-fg">{title}</div>}
          {children && <div className={cn('text-fg-secondary', Boolean(title) && 'mt-0.5')}>{children}</div>}
        </div>
      </div>
      {action && <div className="flex shrink-0 items-center gap-2 pl-7 sm:pl-0">{action}</div>}
    </div>
  );
}

/** One-line inline error under a control or action row. */
export function InlineError({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p role="alert" className={cn('flex items-start gap-1.5 text-body-sm text-danger', className)}>
      <CircleAlert className="mt-0.5 size-3.5" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

/* ── Empty & error states ──────────────────────────────────────────────────── */

export function EmptyState({
  title,
  description,
  action,
  icon: Icon,
  compact,
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: LucideIcon;
  /** Borderless, tighter variant for use inside an existing panel. */
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'px-4 py-10' : 'rounded-md border border-dashed border-line px-6 py-16',
        className,
      )}
    >
      {Icon && (
        <div className="mb-4 grid size-10 place-items-center rounded-md border border-line bg-raised text-fg-muted">
          <Icon className="size-5" aria-hidden />
        </div>
      )}
      <h3 className="text-h4 text-fg">{title}</h3>
      {description && <p className="mt-1.5 max-w-md text-body-sm text-fg-secondary">{description}</p>}
      {action && <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}

/** Failed query: what happened, why, and a retry. Detects "API unreachable". */
export function ErrorState({
  title = 'Couldn’t load this data',
  error,
  onRetry,
  retrying,
  compact,
}: {
  title?: string;
  error: unknown;
  onRetry?: () => void;
  retrying?: boolean;
  compact?: boolean;
}) {
  const unreachable = axios.isAxiosError(error) && !error.response;
  return (
    <EmptyState
      compact={compact}
      icon={unreachable ? CloudOff : TriangleAlert}
      title={unreachable ? 'Can’t reach the CloudOps API' : title}
      description={
        unreachable
          ? 'The API server didn’t respond. Check that it’s running, then try again.'
          : apiErrorMessage(error)
      }
      action={
        onRetry && (
          <Button variant="secondary" size="sm" icon={RefreshCw} onClick={onRetry} loading={retrying}>
            Try again
          </Button>
        )
      }
    />
  );
}
