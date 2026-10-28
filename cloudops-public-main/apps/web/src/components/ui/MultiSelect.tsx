import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import { Checkbox } from './Form';
import { cn } from './cn';

export interface MultiSelectOption {
  value: string;
  label?: string;
}

/**
 * Compact checkbox dropdown for multi-select filters. Shows a count badge, an
 * optional in-dropdown search, and a clear action. Closes on outside click or
 * Escape (returning focus to the trigger).
 */
export function MultiSelect({
  label,
  options,
  selected,
  onChange,
  searchable = true,
}: {
  label: string;
  options: MultiSelectOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  searchable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popId = useId();

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

  const filtered = q
    ? options.filter((o) => (o.label ?? o.value).toLowerCase().includes(q.toLowerCase()))
    : options;

  function toggle(v: string) {
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  }

  const active = selected.length > 0;

  return (
    <div className="relative" ref={ref}>
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-controls={open ? popId : undefined}
        className={cn(
          'inline-flex h-9 items-center gap-2 rounded-sm border px-3 text-body transition-colors duration-150',
          active
            ? 'border-accent/40 bg-accent/10 text-fg hover:border-accent/60'
            : 'border-line bg-canvas text-fg-secondary hover:border-line-strong hover:text-fg',
        )}
      >
        {label}
        {active && (
          <span className="grid h-[18px] min-w-[18px] place-items-center rounded-xs bg-accent px-1 font-mono text-[11px] font-medium text-accent-fg">
            {selected.length}
          </span>
        )}
        <ChevronDown
          className={cn('size-4 text-fg-muted transition-transform duration-150', open && 'rotate-180')}
          aria-hidden
        />
      </button>
      {open && (
        <div
          id={popId}
          role="group"
          aria-label={`${label} filter`}
          className="absolute left-0 z-30 mt-1.5 w-72 max-w-[calc(100vw-2rem)] origin-top-left animate-pop-in rounded-md border border-line-strong bg-overlay p-1.5 shadow-2"
        >
          {searchable && (
            <div className="relative mb-1.5">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-muted" aria-hidden />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={`Search ${label.toLowerCase()}…`}
                aria-label={`Search ${label.toLowerCase()}`}
                className="h-8 w-full rounded-sm border border-line bg-canvas pl-8 pr-2 text-body-sm text-fg outline-none placeholder:text-fg-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
              />
            </div>
          )}
          <div className="max-h-64 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-2 py-3 text-center text-caption text-fg-muted">No matches</div>
            ) : (
              filtered.map((o) => (
                <Checkbox key={o.value} checked={selected.includes(o.value)} onChange={() => toggle(o.value)}>
                  {o.label ?? o.value}
                </Checkbox>
              ))
            )}
          </div>
          {selected.length > 0 && (
            <div className="mt-1.5 border-t border-line pt-1.5">
              <button
                type="button"
                onClick={() => onChange([])}
                className="h-7 w-full rounded-sm text-caption font-medium text-fg-muted transition-colors duration-150 hover:bg-hover hover:text-fg"
              >
                Clear {selected.length} selected
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
