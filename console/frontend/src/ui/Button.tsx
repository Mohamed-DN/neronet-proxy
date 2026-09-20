import { forwardRef } from 'react';
import { Loader2, type LucideIcon } from 'lucide-react';

import { cn } from './cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Icon drawn before the label. Decorative: the label carries the meaning. */
  icon?: LucideIcon;
  /** Shows a spinner and disables the button. The label stays readable. */
  loading?: boolean;
  /** Announced while `loading`, for a reader that cannot see the spinner. */
  loadingLabel?: string;
  fullWidth?: boolean;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-contrast hover:bg-accent-strong border border-transparent',
  secondary: 'bg-surface-raised text-content border border-border-strong hover:bg-surface-hover',
  ghost: 'bg-transparent text-content border border-transparent hover:bg-surface-hover',
  danger: 'bg-danger text-danger-contrast hover:bg-danger-strong border border-transparent'
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-caption gap-1.5',
  md: 'h-9 px-3.5 text-body gap-2'
};

/**
 * The one button in the console. Everything that submits, opens or navigates
 * uses it, so the focus ring, the disabled treatment and the busy state are
 * decided once.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    icon: Icon,
    loading = false,
    loadingLabel,
    fullWidth = false,
    className,
    children,
    disabled,
    type = 'button',
    ...props
  },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center rounded-control font-medium',
        'transition-colors focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        fullWidth && 'w-full',
        className
      )}
      {...props}
    >
      {loading ? (
        <Loader2 aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin" />
      ) : (
        Icon && <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
      )}
      <span>{children}</span>
      {loading && loadingLabel && (
        <span role="status" className="sr-only">
          {loadingLabel}
        </span>
      )}
    </button>
  );
});
