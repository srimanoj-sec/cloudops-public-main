import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Check, ChevronLeft, ChevronRight, Copy, X } from 'lucide-react';
import { IconButton } from './Button';
import { cn } from './cn';

/* ── Tones ─────────────────────────────────────────────────────────────────── */

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';
/** Older tone names still accepted by <Badge>. */
type LegacyTone = 'slate' | 'green' | 'amber' | 'red' | 'blue';
const LEGACY: Record<LegacyTone, Tone> = {
  slate: 'neutral',
  green: 'success',
  amber: 'warning',
  red: 'danger',
  blue: 'accent',
};
const resolveTone = (t: Tone | LegacyTone): Tone => (t in LEGACY ? LEGACY[t as LegacyTone] : (t as Tone));

export const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-fg',
  accent: 'text-accent',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  info: 'text-info',
};
export const TONE_FILL: Record<Tone, string> = {
  neutral: 'bg-fg-muted',
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
};

/** ≥80 healthy, ≥50 degraded, else failing — used for every 0–100 score. */
export function scoreTone(score: number): Tone {
  return score >= 80 ? 'success' : score >= 50 ? 'warning' : 'danger';
}
export function severityTone(sev: string): Tone {
  return sev === 'high' ? 'danger' : sev === 'medium' ? 'warning' : 'neutral';
}

/* ── Badge & status ────────────────────────────────────────────────────────── */

const BADGE_TONES: Record<Tone, string> = {
  neutral: 'border-line bg-raised text-fg-secondary',
  accent: 'border-accent/25 bg-accent/10 text-accent',
  success: 'border-success/25 bg-success/10 text-success',
  warning: 'border-warning/25 bg-warning/10 text-warning',
  danger: 'border-danger/25 bg-danger/10 text-danger',
  info: 'border-info/25 bg-info/10 text-info',
};

export function Badge({
  children,
  tone = 'neutral',
  dot,
  pulse,
  mono,
  className,
  title,
}: {
  children: ReactNode;
  tone?: Tone | LegacyTone;
  /** Leading status dot (so state never relies on colour alone, pair with text). */
  dot?: boolean;
  pulse?: boolean;
  mono?: boolean;
  className?: string;
  title?: string;
}) {
  const t = resolveTone(tone);
  return (
    <span
      title={title}
      className={cn(
        'inline-flex h-5 max-w-full items-center gap-1.5 whitespace-nowrap rounded-xs border px-1.5 text-caption font-medium',
        mono && 'font-mono',
        BADGE_TONES[t],
        className,
      )}
    >
      {dot && (
        <span
          aria-hidden
          className={cn('size-1.5 shrink-0 rounded-full', TONE_FILL[t], pulse && 'animate-signal-pulse')}
        />
      )}
      <span className="truncate">{children}</span>
    </span>
  );
}

const RUN_STATUS: Record<string, { tone: Tone; label: string; pulse?: boolean }> = {
  completed: { tone: 'success', label: 'Completed' },
  running: { tone: 'accent', label: 'Running', pulse: true },
  queued: { tone: 'neutral', label: 'Queued', pulse: true },
  failed: { tone: 'danger', label: 'Failed' },
};

/** Status of a background job (sync / cost sync). */
export function RunStatusBadge({ status }: { status: string }) {
  const s = RUN_STATUS[status] ?? { tone: 'neutral' as Tone, label: status };
  return (
    <Badge tone={s.tone} dot pulse={s.pulse}>
      {s.label}
    </Badge>
  );
}

/* ── Chip (removable filter token) ─────────────────────────────────────────── */

export function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex h-7 max-w-[18rem] animate-fade-in items-center gap-1 rounded-xs border border-line bg-raised pl-2.5 pr-1 text-caption text-fg-secondary">
      <span className="truncate">{label}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove filter ${label}`}
        className="grid size-5 shrink-0 place-items-center rounded-xs text-fg-muted transition-colors duration-150 hover:bg-hover hover:text-fg"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </span>
  );
}

/* ── Readouts (KPI instrument strip) ───────────────────────────────────────── */

/** Container for a row of <Readout> cells separated by hairlines. */
export function ReadoutGrid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="overflow-hidden rounded-md border border-line bg-surface">
      <div className={cn('cell-grid', className)}>{children}</div>
    </div>
  );
}

export function Readout({
  label,
  value,
  hint,
  tone,
  to,
  visual,
  badge,
  size = 'md',
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  /** Makes the whole cell a link. */
  to?: string;
  /** A small visual under the value (e.g. <SegmentMeter>). */
  visual?: ReactNode;
  /** Top-right slot (e.g. a delta badge). */
  badge?: ReactNode;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const body = (
    <>
      <div className="flex min-h-5 items-start justify-between gap-2">
        <span className="font-mono text-overline uppercase text-fg-muted">{label}</span>
        {badge}
        {to && !badge && (
          <ArrowUpRight
            className="size-4 text-fg-faint transition-[color,transform] duration-150 group-hover:-translate-y-px group-hover:translate-x-px group-hover:text-accent"
            aria-hidden
          />
        )}
      </div>
      <div
        className={cn(
          'mt-2 font-mono tabular-nums',
          size === 'md' ? 'text-readout' : 'text-readout-sm',
          tone ? TONE_TEXT[tone] : 'text-fg',
        )}
      >
        {value}
      </div>
      {hint != null && <div className="mt-1.5 min-h-4 text-caption text-fg-muted">{hint}</div>}
      {visual && <div className="mt-auto pt-4">{visual}</div>}
    </>
  );
  const cls = cn('flex min-w-0 flex-col bg-surface p-4 md:p-5', className);
  return to ? (
    <Link to={to} className={cn(cls, 'group transition-colors duration-150 hover:bg-raised focus-inset')}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/* ── Meters ────────────────────────────────────────────────────────────────── */

/** Thin horizontal bar. Decorative unless `label` is given. */
export function Meter({
  value,
  max = 100,
  tone = 'accent',
  size = 'md',
  className,
  label,
}: {
  value: number;
  max?: number;
  tone?: Tone;
  /** sm = 4px hairline (inline in lists), md = 6px. */
  size?: 'sm' | 'md';
  /** Layout classes only (width, grid placement) — height comes from `size`. */
  className?: string;
  label?: string;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div
      className={cn('w-full overflow-hidden rounded-full bg-raised', size === 'sm' ? 'h-1' : 'h-1.5', className)}
      {...(label
        ? { role: 'meter', 'aria-label': label, 'aria-valuenow': Math.round(value), 'aria-valuemin': 0, 'aria-valuemax': max }
        : { 'aria-hidden': true })}
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-500 ease-out', TONE_FILL[tone])}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/** LED-style segmented meter for 0–100 scores — the dashboard's instrument read. */
export function SegmentMeter({
  value,
  segments = 20,
  tone,
  size = 'md',
  label,
  className,
}: {
  value: number;
  segments?: number;
  tone?: Tone;
  /** sm = 6px strip, md = 10px. */
  size?: 'sm' | 'md';
  label?: string;
  /** Layout classes only (margins, width) — height comes from `size`. */
  className?: string;
}) {
  const filled = Math.round((Math.max(0, Math.min(100, value)) / 100) * segments);
  const t = tone ?? scoreTone(value);
  return (
    <div
      className={cn('flex items-stretch gap-[2px]', size === 'sm' ? 'h-1.5' : 'h-2.5', className)}
      role="meter"
      aria-label={label ?? 'Score'}
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      {Array.from({ length: segments }).map((_, i) => (
        <span key={i} className={cn('flex-1 rounded-[1px]', i < filled ? TONE_FILL[t] : 'bg-raised')} />
      ))}
    </div>
  );
}

/* ── Key/value list ────────────────────────────────────────────────────────── */

export function DescriptionList({
  items,
  className,
}: {
  items: { label: ReactNode; value: ReactNode; mono?: boolean }[];
  className?: string;
}) {
  return (
    <dl className={cn('divide-y divide-line-subtle', className)}>
      {items.map((it, i) => (
        <div key={i} className="grid grid-cols-1 gap-1 py-2.5 sm:grid-cols-[minmax(8rem,2fr)_minmax(0,5fr)] sm:gap-4">
          <dt className="text-body-sm text-fg-muted">{it.label}</dt>
          <dd className={cn('min-w-0 break-words text-body-sm text-fg', it.mono && 'font-mono text-caption')}>
            {it.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/* ── Pagination ────────────────────────────────────────────────────────────── */

export function Pagination({
  page,
  totalPages,
  total,
  pageSize,
  noun = 'items',
  onPrev,
  onNext,
}: {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  noun?: string;
  onPrev: () => void;
  onNext: () => void;
}) {
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-body-sm text-fg-muted">
        <span className="font-mono tabular-nums text-fg-secondary">
          {from}–{to}
        </span>{' '}
        of <span className="font-mono tabular-nums text-fg-secondary">{total}</span> {noun}
      </p>
      <div className="flex items-center gap-1">
        <span className="mr-2 font-mono text-caption tabular-nums text-fg-muted">
          {page} / {Math.max(1, totalPages)}
        </span>
        <IconButton icon={ChevronLeft} label="Previous page" variant="secondary" size="sm" disabled={page <= 1} onClick={onPrev} />
        <IconButton icon={ChevronRight} label="Next page" variant="secondary" size="sm" disabled={page >= totalPages} onClick={onNext} />
      </div>
    </nav>
  );
}

/* ── Copy to clipboard ─────────────────────────────────────────────────────── */

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <IconButton
      icon={copied ? Check : Copy}
      label={copied ? 'Copied' : label}
      size="sm"
      className={copied ? 'text-success' : 'text-fg-muted'}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(value).then(() => setCopied(true), () => undefined);
      }}
    />
  );
}

/** Mono identifier (GUID / resource id) with a copy affordance. */
export function MonoId({ value, className, truncate }: { value: string; className?: string; truncate?: boolean }) {
  return (
    <span className={cn('inline-flex min-w-0 max-w-full items-center gap-1', className)}>
      <span className={cn('font-mono text-caption text-fg-muted', truncate ? 'truncate' : 'break-all')} title={value}>
        {value}
      </span>
      <CopyButton value={value} label="Copy ID" />
    </span>
  );
}
