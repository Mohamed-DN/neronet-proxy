import { cn } from './cn';

export interface PageHeaderProps {
  title: string;
  /** One sentence on what the page shows and where the numbers come from. */
  description?: React.ReactNode;
  /** Secondary page actions, end-aligned before the primary action. */
  actions?: React.ReactNode;
  /** The one action this page offers as its signal. At most one per page. */
  primaryAction?: React.ReactNode;
  /** Status of the page as a whole: a StatusBadge, a data-source note. */
  meta?: React.ReactNode;
  className?: string;
}

/** The h1 of a page. One per view, so the document has one heading level 1. */
export function PageHeader({ title, description, actions, primaryAction, meta, className }: PageHeaderProps) {
  return (
    <header
      className={cn(
        'mb-6 flex flex-wrap items-end justify-between gap-4 border-b border-border-subtle pb-4',
        className
      )}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-display font-semibold tracking-tight text-content">{title}</h1>
          {meta}
        </div>
        {description && <p className="mt-1 max-w-[65ch] text-body text-muted">{description}</p>}
      </div>
      {(actions || primaryAction) && (
        <div className="flex shrink-0 items-center gap-2">
          {actions}
          {primaryAction}
        </div>
      )}
    </header>
  );
}
