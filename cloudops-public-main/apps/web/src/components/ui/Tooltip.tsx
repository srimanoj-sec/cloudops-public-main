import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn';

type Side = 'top' | 'right' | 'bottom';

/**
 * Hover/focus tooltip rendered in a portal (never clipped by scroll containers).
 * Purely visual: the trigger must carry its own accessible name (e.g. aria-label).
 */
export function Tooltip({
  content,
  side = 'top',
  disabled,
  children,
  className,
}: {
  content: ReactNode;
  side?: Side;
  disabled?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const id = useId();

  const show = useCallback(() => {
    const el = anchor.current;
    if (!el || disabled) return;
    const r = el.getBoundingClientRect();
    if (side === 'right') setPos({ x: r.right + 8, y: r.top + r.height / 2 });
    else if (side === 'bottom') setPos({ x: r.left + r.width / 2, y: r.bottom + 6 });
    else setPos({ x: r.left + r.width / 2, y: r.top - 6 });
  }, [side, disabled]);
  const hide = useCallback(() => setPos(null), []);

  // Hide if the page scrolls underneath an open tooltip.
  useLayoutEffect(() => {
    if (!pos) return;
    window.addEventListener('scroll', hide, true);
    return () => window.removeEventListener('scroll', hide, true);
  }, [pos, hide]);

  const transform =
    side === 'right' ? 'translate(0, -50%)' : side === 'bottom' ? 'translate(-50%, 0)' : 'translate(-50%, -100%)';

  return (
    <span
      ref={anchor}
      className={cn('inline-flex', className)}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {pos &&
        content &&
        createPortal(
          <span
            id={id}
            role="tooltip"
            aria-hidden
            className="pointer-events-none fixed z-[70] max-w-xs animate-fade-in whitespace-nowrap rounded-xs border border-line-strong bg-overlay px-2 py-1 text-caption text-fg shadow-2"
            style={{ left: pos.x, top: pos.y, transform }}
          >
            {content}
          </span>,
          document.body,
        )}
    </span>
  );
}
