import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ExternalLink, type LucideIcon } from 'lucide-react';
import { Button, type ButtonVariant } from './Button';
import { cn } from './cn';

export interface MenuItem {
  key: string;
  label: ReactNode;
  icon?: LucideIcon;
  /** Secondary line (what it does, why it's unavailable). */
  hint?: ReactNode;
  onSelect?: () => void;
  /** In-app route. */
  to?: string;
  /** External URL (opens a new tab). */
  href?: string;
  disabled?: boolean;
  tone?: 'default' | 'danger';
}

export interface MenuSection {
  label?: string;
  items: MenuItem[];
}

/**
 * Button + dropdown of actions (ARIA menu). Arrow keys move, Enter selects,
 * Escape closes and returns focus. Sections group related actions.
 */
export function Menu({
  label,
  icon,
  sections,
  variant = 'secondary',
  size = 'md',
  align = 'right',
}: {
  label: string;
  icon?: LucideIcon;
  sections: MenuSection[];
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const visible = sections.filter((s) => s.items.length > 0);

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
    const onDoc = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  function onKeyDown(e: KeyboardEvent) {
    const items = Array.from(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    }
  }

  const close = () => setOpen(false);
  const itemClass = (it: MenuItem) =>
    cn(
      'flex w-full items-start gap-2.5 rounded-sm px-2.5 py-2 text-left text-body-sm transition-colors duration-100 focus:outline-none',
      it.disabled
        ? 'cursor-not-allowed opacity-50'
        : it.tone === 'danger'
          ? 'text-danger hover:bg-danger/10 focus:bg-danger/10'
          : 'text-fg-secondary hover:bg-hover hover:text-fg focus:bg-hover focus:text-fg',
    );
  const body = (it: MenuItem) => (
    <>
      {it.icon && <it.icon className="mt-0.5 size-4 shrink-0 text-fg-muted" aria-hidden />}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 font-medium">
          {it.label}
          {it.href && <ExternalLink className="size-3 text-fg-muted" aria-hidden />}
        </span>
        {it.hint && <span className="mt-0.5 block text-caption text-fg-muted">{it.hint}</span>}
      </span>
    </>
  );

  return (
    <div ref={root} className="relative" onKeyDown={onKeyDown}>
      <Button
        ref={trigger}
        variant={variant}
        size={size}
        icon={icon}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
        <ChevronDown className={cn('size-3.5 transition-transform duration-150', open && 'rotate-180')} aria-hidden />
      </Button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          className={cn(
            'absolute top-full z-40 mt-1.5 max-h-[70vh] w-80 animate-pop-in overflow-y-auto rounded-md border border-line-strong bg-overlay p-1.5 shadow-2',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {visible.map((s, si) => (
            <div key={si} className={cn(si > 0 && 'mt-1.5 border-t border-line pt-1.5')}>
              {s.label && <div className="px-2.5 pb-1 pt-1 font-mono text-overline uppercase text-fg-muted">{s.label}</div>}
              {s.items.map((it) =>
                it.disabled ? (
                  <div key={it.key} role="menuitem" aria-disabled="true" tabIndex={-1} className={itemClass(it)}>
                    {body(it)}
                  </div>
                ) : it.to ? (
                  <Link key={it.key} to={it.to} role="menuitem" tabIndex={-1} className={itemClass(it)} onClick={close}>
                    {body(it)}
                  </Link>
                ) : it.href ? (
                  <a key={it.key} href={it.href} target="_blank" rel="noreferrer" role="menuitem" tabIndex={-1} className={itemClass(it)} onClick={close}>
                    {body(it)}
                  </a>
                ) : (
                  <button
                    key={it.key}
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className={itemClass(it)}
                    onClick={() => {
                      close();
                      it.onSelect?.();
                    }}
                  >
                    {body(it)}
                  </button>
                ),
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
