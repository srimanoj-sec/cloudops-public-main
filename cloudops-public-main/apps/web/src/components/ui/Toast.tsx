import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CircleAlert, CircleCheck, Info, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import { cn } from './cn';

type ToastTone = 'success' | 'info' | 'warning' | 'danger';
interface ToastInput {
  title: string;
  description?: ReactNode;
  tone?: ToastTone;
}
interface ToastItem extends Required<Pick<ToastInput, 'title' | 'tone'>> {
  id: number;
  description?: ReactNode;
}

const TONES: Record<ToastTone, { Icon: LucideIcon; icon: string; bar: string }> = {
  success: { Icon: CircleCheck, icon: 'text-success', bar: 'bg-success' },
  info: { Icon: Info, icon: 'text-info', bar: 'bg-info' },
  warning: { Icon: TriangleAlert, icon: 'text-warning', bar: 'bg-warning' },
  danger: { Icon: CircleAlert, icon: 'text-danger', bar: 'bg-danger' },
};

const ToastContext = createContext<((t: ToastInput) => void) | null>(null);

/** Transient confirmations for background actions (sync queued, item saved…). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const toast = useCallback((t: ToastInput) => {
    const item: ToastItem = { id: nextId.current++, title: t.title, description: t.description, tone: t.tone ?? 'success' };
    setItems((xs) => [...xs.slice(-3), item]);
  }, []);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      {createPortal(
        <div
          aria-live="polite"
          aria-atomic="false"
          className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:inset-x-auto sm:right-0 sm:items-end sm:p-6"
        >
          {items.map((t) => (
            <ToastView key={t.id} item={t} onDismiss={dismiss} />
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

function ToastView({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const t = setTimeout(() => onDismiss(item.id), item.tone === 'danger' ? 8000 : 5000);
    return () => clearTimeout(t);
  }, [paused, item.id, item.tone, onDismiss]);
  const tone = TONES[item.tone];
  return (
    <div
      role={item.tone === 'danger' ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className="pointer-events-auto relative flex w-full max-w-sm animate-toast-in items-start gap-3 overflow-hidden rounded-md border border-line-strong bg-overlay py-3 pl-4 pr-2 shadow-3"
    >
      <span aria-hidden className={cn('absolute inset-y-0 left-0 w-0.5', tone.bar)} />
      <tone.Icon className={cn('mt-0.5 size-4', tone.icon)} aria-hidden />
      <div className="min-w-0 flex-1 text-body-sm">
        <div className="font-medium text-fg">{item.title}</div>
        {item.description && <div className="mt-0.5 text-fg-secondary">{item.description}</div>}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(item.id)}
        aria-label="Dismiss notification"
        className="grid size-6 shrink-0 place-items-center rounded-xs text-fg-muted transition-colors duration-150 hover:bg-hover hover:text-fg"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
