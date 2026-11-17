import { createContext, useContext } from 'react';

import { cn } from './cn';

/**
 * Where the current page sits in the navigation: "Network", "Map". The shell
 * provides it from the route, so a page never spells out its own breadcrumb and
 * it cannot drift from the top bar. Outside the shell (the portal, the design
 * gallery, tests) there is none and the header draws without one.
 */
export interface Breadcrumb {
  /** Accessible name of the breadcrumb landmark. */
  label: string;
  /** Ancestors first, the current page last. */
  trail: string[];
}

export const BreadcrumbContext = createContext<Breadcrumb | null>(null);

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
  const breadcrumb = useContext(BreadcrumbContext);
  const trail = breadcrumb && breadcrumb.trail.length > 1 ? breadcrumb : null;

  return (
    <header className={cn('mb-6 flex flex-wrap items-end justify-between gap-4 border-b border-rule pb-4', className)}>
      <div className="min-w-0">
        {trail && (
          <nav aria-label={trail.label} className="mb-1">
            <ol className="flex flex-wrap items-center gap-1.5 text-caption text-muted">
              {trail.trail.map((step, index) => {
                const last = index === trail.trail.length - 1;
                return (
                  <li key={`${index}-${step}`} className="flex items-center gap-1.5">
                    <span aria-current={last ? 'page' : undefined} className={cn(last && 'font-medium text-content')}>
                      {step}
                    </span>
                    {!last && <span aria-hidden="true">&rsaquo;</span>}
                  </li>
                );
              })}
            </ol>
          </nav>
        )}
        <div className="flex items-center gap-2">
          <h1 className="truncate text-display font-semibold text-content">{title}</h1>
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
