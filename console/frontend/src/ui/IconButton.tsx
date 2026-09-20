import { forwardRef } from 'react';
import type { LucideIcon } from 'lucide-react';

import { cn } from './cn';

export type IconButtonVariant = 'secondary' | 'ghost' | 'danger';

export interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: LucideIcon;
  /**
   * What the button does, in words. Required: a button whose only content is a
   * picture has no accessible name without it, and `title` is not a label.
   */
  label: string;
  variant?: IconButtonVariant;
  size?: 'sm' | 'md';
}

const VARIANTS: Record<IconButtonVariant, string> = {
  secondary: 'bg-surface-raised text-content border border-border-strong hover:bg-surface-hover',
  ghost: 'bg-transparent text-muted border border-transparent hover:bg-surface-hover hover:text-content',
  danger: 'bg-transparent text-danger border border-transparent hover:bg-danger/10'
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Icon, label, variant = 'ghost', size = 'md', className, type = 'button', ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-control transition-colors',
        'focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-7 w-7' : 'h-9 w-9',
        VARIANTS[variant],
        className
      )}
      {...props}
    >
      <Icon aria-hidden="true" className={size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
    </button>
  );
});
