import { useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { IconButton } from './Button';
import { cn } from './cn';
import { useFocusTrap } from './useFocusTrap';

const SIZES = { sm: 'max-w-md', md: 'max-w-2xl', lg: 'max-w-4xl' } as const;

/**
 * Accessible dialog: portal-rendered, focus-trapped, Escape / backdrop to close
 * (topmost dialog only), focus restored to the trigger on close.
 */
export function Modal({
  title,
  description,
  onClose,
  children,
  footer,
  wide,
  size,
  dismissible = true,
}: {
  title: ReactNode;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Legacy: same as size="lg". */
  wide?: boolean;
  size?: keyof typeof SIZES;
  /** false: no close button, Escape or backdrop — the footer is the only way out. */
  dismissible?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const downOnBackdrop = useRef(false);
  const close = dismissible ? onClose : () => undefined;
  useFocusTrap(panel, close);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-end justify-center overflow-y-auto bg-canvas/70 p-0 backdrop-blur-[2px] sm:items-start sm:p-6 sm:pt-[10vh]"
      // Close only when the press *started* on the backdrop (not a text-selection drag out of the panel).
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        e.stopPropagation();
        if (downOnBackdrop.current && e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cn(
          'flex max-h-[92dvh] w-full animate-dialog-in flex-col rounded-t-lg border border-line-strong bg-overlay shadow-3 focus:outline-none sm:max-h-[84dvh] sm:rounded-lg',
          SIZES[size ?? (wide ? 'lg' : 'md')],
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-h3 text-fg">
              {title}
            </h2>
            {description && (
              <p id={descId} className="mt-1 text-body-sm text-fg-muted">
                {description}
              </p>
            )}
          </div>
          {dismissible && (
            <IconButton icon={X} label="Close dialog" size="sm" tooltip={false} className="-mr-1.5 -mt-0.5" onClick={onClose} />
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">{children}</div>
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface/60 px-5 py-3 sm:rounded-b-lg">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
