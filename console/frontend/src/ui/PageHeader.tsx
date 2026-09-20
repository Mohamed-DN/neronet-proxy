import { cn } from './cn';

export interface PageHeaderProps {
  title: string;
  /** One sentence on what the page shows and where the numbers come from. */
  description?: React.ReactNode;
  /** Page-level actions, end-aligned. */
  actions?: React.ReactNode;
  /** Status of the page as a whole: a StatusBadge, a data-source note. */
  meta?: React.ReactNode;
  className?: string;
}

/** The h1 of a page. One per view, so the document has one heading level 1. */
export function PageHeader({ title, description, actions, meta, className }: PageHeaderProps) {
  return (
    <header className={cn('flex flex-wrap items-start justify-between gap-3 pb-4', className)}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-title font-semibold text-content">{title}</h1>
          {meta}
        </div>
        {description && <p className="mt-1 max-w-prose text-caption text-subtle">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
