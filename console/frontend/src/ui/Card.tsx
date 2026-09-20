import { cn } from './cn';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Removes the body padding, for a card whose child is a full-bleed table. */
  flush?: boolean;
}

/**
 * The container for everything. Separated from the page by a border, not a
 * shadow: on a dense screen a dozen drop shadows read as noise, and a border
 * survives both themes without tuning.
 */
export function Card({ flush = false, className, children, ...props }: CardProps) {
  return (
    <div className={cn('rounded-card border border-border bg-surface-raised', !flush && 'p-4', className)} {...props}>
      {children}
    </div>
  );
}

export interface CardHeaderProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Actions for this card, aligned to the end of the header row. */
  actions?: React.ReactNode;
  /** Heading level. A card inside a section is usually an h3. */
  as?: 'h2' | 'h3' | 'h4';
}

export function CardHeader({ title, description, actions, as: Heading = 'h3', className, ...props }: CardHeaderProps) {
  return (
    <div className={cn('flex items-start justify-between gap-4 pb-3', className)} {...props}>
      <div className="min-w-0">
        <Heading className="truncate text-heading font-semibold text-content">{title}</Heading>
        {description && <p className="mt-0.5 text-caption text-subtle">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
