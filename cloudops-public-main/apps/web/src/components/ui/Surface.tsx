import type { ReactNode } from 'react';
import { cn } from './cn';

/**
 * Panel — the one container surface. Hairline border on `surface`, no heavy
 * shadow. Optional header (title / description / actions); `flush` removes body
 * padding for edge-to-edge tables and lists.
 */
export function Panel({
  title,
  description,
  actions,
  overline,
  flush,
  footer,
  className,
  bodyClassName,
  children,
  as: Tag = 'section',
  id,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  overline?: ReactNode;
  flush?: boolean;
  footer?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
  as?: 'section' | 'div' | 'article';
  id?: string;
}) {
  const hasHeader = Boolean(title || actions || overline);
  return (
    <Tag id={id} className={cn('min-w-0 rounded-md border border-line bg-surface', className)}>
      {hasHeader && (
        <header
          className={cn(
            'flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 pt-4 md:px-5',
            flush ? 'border-b border-line-subtle pb-3' : 'pb-0',
          )}
        >
          <div className="min-w-0">
            {overline && <div className="mb-1 font-mono text-overline uppercase text-fg-muted">{overline}</div>}
            {title && <h2 className="text-h4 text-fg">{title}</h2>}
            {description && <p className="mt-0.5 text-body-sm text-fg-muted">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn(flush ? '' : hasHeader ? 'px-4 pb-4 pt-3 md:px-5 md:pb-5' : 'p-4 md:p-5', bodyClassName)}>
        {children}
      </div>
      {footer && <footer className="border-t border-line-subtle px-4 py-3 md:px-5">{footer}</footer>}
    </Tag>
  );
}

/** Legacy name — a padded Panel. */
export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <Panel className={className}>{children}</Panel>;
}

/** Page title block: overline (section), title, one-line purpose, primary actions. */
export function PageHeader({
  title,
  subtitle,
  actions,
  overline,
  meta,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  overline?: ReactNode;
  /** Small status row under the subtitle (badges, timestamps). */
  meta?: ReactNode;
  /** Optional content above the title (e.g. a back link). */
  children?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div className="min-w-0">
        {children}
        {overline && <div className="mb-1.5 font-mono text-overline uppercase text-accent/90">{overline}</div>}
        <h1 className="break-words text-h1 text-fg">{title}</h1>
        {subtitle && <p className="mt-1.5 max-w-3xl text-body text-fg-secondary">{subtitle}</p>}
        {meta && <div className="mt-3 flex flex-wrap items-center gap-2">{meta}</div>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** In-page section label — mono overline with optional count and actions. */
export function SectionHeading({
  title,
  count,
  icon,
  meta,
  actions,
  className,
}: {
  title: ReactNode;
  count?: number;
  icon?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-3 flex flex-wrap items-center justify-between gap-2', className)}>
      <h2 className="flex flex-wrap items-center gap-2 font-mono text-overline uppercase text-fg-secondary">
        {icon}
        {title}
        {count != null && (
          <span className="rounded-xs bg-raised px-1.5 py-px text-fg-muted tabular-nums">{count}</span>
        )}
        {meta && <span className="font-sans text-caption normal-case tracking-normal text-fg-muted">{meta}</span>}
      </h2>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
