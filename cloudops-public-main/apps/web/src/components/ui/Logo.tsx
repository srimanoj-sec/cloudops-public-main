import { cn } from './cn';

/**
 * CloudOps mark: a console frame with a signal sweep — "instrument panel for
 * your estate". Drawn with currentColor strokes so it inherits the accent.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden className={cn('size-8', className)}>
      <rect x="1" y="1" width="30" height="30" rx="7" className="fill-accent/10 stroke-accent/40" strokeWidth="1.5" />
      <path d="M8 21.5a8 8 0 0 1 16 0" className="stroke-accent" strokeWidth="2" strokeLinecap="round" />
      <path d="M12 21.5a4 4 0 0 1 8 0" className="stroke-accent/55" strokeWidth="2" strokeLinecap="round" />
      <path d="M16 21.5 21.2 13" className="stroke-fg" strokeWidth="2" strokeLinecap="round" />
      <circle cx="16" cy="21.5" r="1.9" className="fill-fg" />
    </svg>
  );
}

export function Wordmark({ collapsed, className }: { collapsed?: boolean; className?: string }) {
  return (
    <span className={cn('flex min-w-0 items-center gap-2.5', className)}>
      <LogoMark className="size-7 shrink-0" />
      {!collapsed && (
        <span className="min-w-0 leading-none">
          <span className="block text-[0.9375rem] font-semibold tracking-[-0.01em] text-fg">CloudOps</span>
          <span className="mt-1 block font-mono text-[10px] uppercase tracking-[0.12em] text-fg-muted">Command center</span>
        </span>
      )}
    </span>
  );
}
