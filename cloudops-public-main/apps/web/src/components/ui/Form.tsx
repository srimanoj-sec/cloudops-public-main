import {
  createContext,
  forwardRef,
  type AriaAttributes,
  useContext,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { ChevronDown, CircleAlert, type LucideIcon } from 'lucide-react';
import { cn } from './cn';

/* ─────────────────────────────────────────────────────────────────────────────
 * Field — label + control + hint + error. Controls rendered inside a Field pick
 * up id / aria-describedby / aria-invalid / required from context automatically.
 * ──────────────────────────────────────────────────────────────────────────── */

interface FieldCtx {
  id: string;
  describedBy?: string;
  invalid: boolean;
  required?: boolean;
}
const FieldContext = createContext<FieldCtx | null>(null);

function useFieldProps(props: {
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: AriaAttributes['aria-invalid'];
  required?: boolean;
}) {
  const ctx = useContext(FieldContext);
  return {
    id: props.id ?? ctx?.id,
    'aria-describedby': props['aria-describedby'] ?? ctx?.describedBy,
    'aria-invalid': props['aria-invalid'] ?? (ctx?.invalid || undefined),
    required: props.required ?? ctx?.required,
  };
}

export function Field({
  label,
  hint,
  error,
  required,
  className,
  children,
  labelAside,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  className?: string;
  children: ReactNode;
  /** Right-aligned content on the label row (e.g. "Markdown", a count). */
  labelAside?: ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;

  return (
    <FieldContext.Provider value={{ id, describedBy, invalid: Boolean(error), required }}>
      <div className={cn('min-w-0', className)}>
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <label htmlFor={id} className="text-label text-fg-secondary">
            {label}
            {required && (
              <span className="ml-0.5 text-danger" aria-hidden>
                *
              </span>
            )}
          </label>
          {labelAside && <span className="text-caption text-fg-muted">{labelAside}</span>}
        </div>
        {children}
        {error ? (
          <p id={errorId} className="mt-1.5 flex items-center gap-1 text-caption text-danger">
            <CircleAlert className="size-3.5" aria-hidden />
            {error}
          </p>
        ) : (
          hint && (
            <p id={hintId} className="mt-1.5 text-caption text-fg-muted">
              {hint}
            </p>
          )
        )}
      </div>
    </FieldContext.Provider>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Controls
 * ──────────────────────────────────────────────────────────────────────────── */

export type ControlSize = 'sm' | 'md';

const CONTROL =
  'w-full min-w-0 rounded-sm border border-line bg-canvas text-fg placeholder:text-fg-muted ' +
  'transition-[border-color,box-shadow] duration-150 ease-out hover:border-line-strong ' +
  'focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 ' +
  'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-line ' +
  'aria-[invalid=true]:border-danger aria-[invalid=true]:focus:ring-danger/20';

const CONTROL_SIZES: Record<ControlSize, string> = {
  sm: 'h-8 px-2.5 text-body-sm',
  md: 'h-9 px-3 text-body',
};

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & {
  controlSize?: ControlSize;
  /** Leading icon inside the control. */
  icon?: LucideIcon;
  /** Right-side adornment inside the control (e.g. a clear or reveal button). */
  trailing?: ReactNode;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, controlSize = 'md', icon: Icon, trailing, ...props },
  ref,
) {
  const field = useFieldProps(props);
  // Layout classes (width, flex, font) go on the wrapper; the input always fills it.
  return (
    <div className={cn('relative min-w-0', className)}>
      {Icon && (
        <Icon
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-muted"
          aria-hidden
        />
      )}
      <input
        ref={ref}
        {...props}
        {...field}
        className={cn(CONTROL, CONTROL_SIZES[controlSize], Icon && 'pl-9', trailing ? 'pr-9' : '')}
      />
      {trailing && <div className="absolute inset-y-0 right-1 flex items-center">{trailing}</div>}
    </div>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    const field = useFieldProps(props);
    return (
      <textarea
        ref={ref}
        {...props}
        {...field}
        className={cn(CONTROL, 'min-h-[5rem] px-3 py-2 text-body leading-relaxed', className)}
      />
    );
  },
);

type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> & {
  controlSize?: ControlSize;
  icon?: LucideIcon;
  /** Classes for the select element itself (className styles the wrapper). */
  selectClassName?: string;
};

/** Native select (keeps platform a11y + mobile pickers) with the system's styling. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, selectClassName, controlSize = 'md', icon: Icon, children, ...props },
  ref,
) {
  const field = useFieldProps(props);
  return (
    <div className={cn('relative inline-flex min-w-0', className)}>
      {Icon && (
        <Icon
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-muted"
          aria-hidden
        />
      )}
      <select
        ref={ref}
        {...props}
        {...field}
        className={cn(
          CONTROL,
          CONTROL_SIZES[controlSize],
          'cursor-pointer appearance-none pr-8',
          Icon && 'pl-9',
          selectClassName,
        )}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-muted"
        aria-hidden
      />
    </div>
  );
});

/** Accessible on/off switch (role="switch"). */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  size = 'md',
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
}) {
  const track = size === 'sm' ? 'h-4 w-7' : 'h-5 w-9';
  const thumb = size === 'sm' ? 'size-3' : 'size-4';
  const shift = size === 'sm' ? 'translate-x-3' : 'translate-x-4';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex shrink-0 items-center rounded-full border p-px transition-colors duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-45',
        track,
        checked ? 'border-accent/60 bg-accent/80' : 'border-line-strong bg-raised hover:bg-hover',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'rounded-full shadow-1 transition-transform duration-200 ease-out',
          thumb,
          checked ? cn(shift, 'bg-accent-fg') : 'translate-x-0 bg-fg-secondary',
        )}
      />
    </button>
  );
}

/** Labelled checkbox row. */
export function Checkbox({
  checked,
  onChange,
  children,
  className,
}: {
  checked: boolean;
  onChange: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-center gap-2.5 rounded-xs px-2 py-1.5 text-body-sm text-fg-secondary transition-colors duration-100 hover:bg-hover hover:text-fg',
        className,
      )}
    >
      <input type="checkbox" className="size-3.5 shrink-0 cursor-pointer" checked={checked} onChange={onChange} />
      <span className="min-w-0 truncate">{children}</span>
    </label>
  );
}
