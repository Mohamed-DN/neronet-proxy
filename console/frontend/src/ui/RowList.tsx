import { createContext, useContext } from 'react';

import { cn } from './cn';

export type RowDensity = 'compact' | 'comfortable';

const DensityContext = createContext<RowDensity>('comfortable');

export interface RowListProps {
  /** Names the list for a screen reader, e.g. "Devices". */
  label: string;
  children: React.ReactNode;
  density?: RowDensity;
  className?: string;
}

/** A list of things as hairline rows. Structure comes from rules, not from cards. */
export function RowList({ label, children, density = 'comfortable', className }: RowListProps) {
  return (
    <DensityContext.Provider value={density}>
      {/* Explicit role keeps list semantics where a browser drops them from list-style: none. */}
      {/* eslint-disable-next-line jsx-a11y/no-redundant-roles */}
      <ul
        role="list"
        aria-label={label}
        className={cn('divide-y divide-border-subtle border-y border-border-subtle', className)}
      >
        {children}
      </ul>
    </DensityContext.Provider>
  );
}

export interface RowProps {
  title: React.ReactNode;
  meta?: React.ReactNode;
  status?: React.ReactNode;
  actions?: React.ReactNode;
  /** Makes the title a button. The actions stay separate controls. */
  onSelect?: () => void;
  className?: string;
}

export function Row({ title, meta, status, actions, onSelect, className }: RowProps) {
  const density = useContext(DensityContext);
  return (
    <li
      className={cn(
        'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-1 py-3',
        density === 'compact' ? 'min-h-11' : 'min-h-14',
        className
      )}
    >
      <div className="min-w-0">
        {onSelect ? (
          <button
            type="button"
            onClick={onSelect}
            className="block max-w-full truncate rounded-sm text-start text-body font-medium text-content hover:underline focus-visible:outline-focus"
          >
            {title}
          </button>
        ) : (
          <div className="truncate text-body font-medium text-content">{title}</div>
        )}
        {meta && <div className="truncate text-caption text-muted">{meta}</div>}
      </div>
      {(status || actions) && (
        <div className="flex items-center justify-end gap-2">
          {status}
          {actions}
        </div>
      )}
    </li>
  );
}
