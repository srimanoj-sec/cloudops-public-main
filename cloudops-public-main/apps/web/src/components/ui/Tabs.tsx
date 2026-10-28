import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from './cn';

/** Roving-focus keyboard handling shared by tabs and segmented controls. */
function useRovingKeys<T extends string>(values: readonly T[], value: T, onChange: (v: T) => void) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  function onKeyDown(e: KeyboardEvent) {
    const i = values.indexOf(value);
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % values.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + values.length) % values.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = values.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onChange(values[next] as T);
    refs.current[next]?.focus();
  }
  return { refs, onKeyDown };
}

/* ── Tabs ──────────────────────────────────────────────────────────────────── */

export interface TabDef<T extends string> {
  id: T;
  label: ReactNode;
  icon?: LucideIcon;
}

/**
 * Underline tabs (ARIA tablist). Render the active panel yourself inside
 * <TabPanel id={active} baseId={baseId}> so tabs and panel are linked.
 */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  baseId,
  label,
  className,
}: {
  tabs: TabDef<T>[];
  value: T;
  onChange: (v: T) => void;
  baseId: string;
  label: string;
  className?: string;
}) {
  const { refs, onKeyDown } = useRovingKeys(
    tabs.map((t) => t.id),
    value,
    onChange,
  );
  return (
    <div className={cn('-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0', className)}>
      <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className="flex min-w-max gap-1 border-b border-line">
        {tabs.map((t, i) => {
          const active = t.id === value;
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${t.id}`}
              aria-selected={active}
              aria-controls={`${baseId}-panel-${t.id}`}
              tabIndex={active ? 0 : -1}
              onClick={() => onChange(t.id)}
              className={cn(
                'focus-inset relative -mb-px inline-flex h-10 items-center gap-2 rounded-t-sm px-3 text-body font-medium transition-colors duration-150',
                active ? 'text-fg' : 'text-fg-muted hover:text-fg-secondary',
              )}
            >
              {Icon && <Icon className={cn('size-4', active ? 'text-accent' : '')} aria-hidden />}
              {t.label}
              <span
                aria-hidden
                className={cn(
                  'absolute inset-x-2 bottom-0 h-0.5 rounded-full transition-colors duration-150',
                  active ? 'bg-accent' : 'bg-transparent',
                )}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function TabPanel({
  id,
  baseId,
  children,
  className,
}: {
  id: string;
  baseId: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="tabpanel"
      id={`${baseId}-panel-${id}`}
      aria-labelledby={`${baseId}-tab-${id}`}
      tabIndex={0}
      className={cn('animate-fade-in focus:outline-none focus-visible:outline-offset-4', className)}
    >
      {children}
    </div>
  );
}

/* ── Segmented control ─────────────────────────────────────────────────────── */

/** Compact single-choice switcher (radiogroup) for view modes, periods, groupings. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  size = 'md',
  className,
}: {
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const { refs, onKeyDown } = useRovingKeys(
    options.map((o) => o.value),
    value,
    onChange,
  );
  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn('inline-flex max-w-full overflow-x-auto rounded-sm border border-line bg-canvas p-0.5', className)}
    >
      {options.map((o, i) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-xs font-medium transition-[background-color,color,box-shadow] duration-150',
              size === 'sm' ? 'h-6 px-2.5 text-caption' : 'h-7 px-3 text-body-sm',
              active
                ? 'bg-raised text-fg shadow-[inset_0_0_0_1px_rgb(var(--line-strong))]'
                : 'text-fg-muted hover:text-fg',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
