import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { LoaderCircle, type LucideIcon } from 'lucide-react';
import { cn } from './cn';
import { Tooltip } from './Tooltip';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost' | 'subtle';
export type ButtonSize = 'sm' | 'md';

const BASE =
  'relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-sm font-medium ' +
  'transition-[background-color,border-color,color,transform] duration-150 ease-out ' +
  'enabled:active:translate-y-px disabled:cursor-not-allowed disabled:opacity-45';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg shadow-1 enabled:hover:bg-accent-hover enabled:active:bg-accent-active',
  secondary:
    'border border-line-strong bg-raised text-fg enabled:hover:border-fg-faint enabled:hover:bg-hover',
  // Legacy alias kept so older call sites keep working.
  subtle: 'border border-line-strong bg-raised text-fg enabled:hover:border-fg-faint enabled:hover:bg-hover',
  ghost: 'text-fg-secondary enabled:hover:bg-hover enabled:hover:text-fg',
  danger: 'bg-danger text-canvas shadow-1 enabled:hover:bg-danger/90',
  'danger-ghost': 'text-danger enabled:hover:bg-danger/10',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-body-sm',
  md: 'h-9 px-4 text-body',
};

const ICON_SIZES: Record<ButtonSize, string> = { sm: 'size-3.5', md: 'size-4' };

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon (swapped for a spinner while `loading`). */
  icon?: LucideIcon;
  /** Shows a spinner and disables the button; keep the label meaningful ("Saving…"). */
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', icon: Icon, loading, disabled, className, children, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(BASE, VARIANTS[variant], SIZES[size], className)}
      {...props}
    >
      {loading ? (
        <LoaderCircle className={cn(ICON_SIZES[size], 'animate-spin')} aria-hidden />
      ) : (
        Icon && <Icon className={ICON_SIZES[size]} aria-hidden />
      )}
      {children}
    </button>
  );
});

/** Square icon-only button. `label` is required: it's the accessible name and the tooltip. */
export const IconButton = forwardRef<
  HTMLButtonElement,
  Omit<ButtonProps, 'children' | 'icon'> & {
    icon: LucideIcon;
    label: string;
    tooltip?: boolean;
    tooltipSide?: 'top' | 'right' | 'bottom';
  }
>(function IconButton(
  { icon: Icon, label, variant = 'ghost', size = 'md', tooltip = true, tooltipSide, loading, disabled, className, type = 'button', ...props },
  ref,
) {
  const btn = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      disabled={disabled || loading}
      className={cn(BASE, VARIANTS[variant], size === 'sm' ? 'size-7' : 'size-9', className)}
      {...props}
    >
      {loading ? (
        <LoaderCircle className={cn(ICON_SIZES[size], 'animate-spin')} aria-hidden />
      ) : (
        <Icon className={ICON_SIZES[size]} aria-hidden />
      )}
    </button>
  );
  return tooltip ? (
    <Tooltip content={label} side={tooltipSide}>
      {btn}
    </Tooltip>
  ) : (
    btn
  );
});

/** Small inline text-style action (e.g. "Clear", "Reset"). */
export function TextButton({
  className,
  children,
  tone = 'accent',
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'accent' | 'muted' | 'danger'; children: ReactNode }) {
  const tones = {
    accent: 'text-accent hover:text-accent-hover',
    muted: 'text-fg-muted hover:text-fg',
    danger: 'text-danger hover:text-danger/80',
  } as const;
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center gap-1 rounded-xs text-body-sm font-medium transition-colors duration-150 disabled:opacity-45',
        tones[tone],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
