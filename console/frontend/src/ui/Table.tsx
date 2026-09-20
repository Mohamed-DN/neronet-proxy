import { useCallback, useId, useMemo } from 'react';
import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from './cn';
import { Checkbox } from './Checkbox';
import { EmptyState, ErrorState, Skeleton } from './States';

export type SortDirection = 'asc' | 'desc';

export interface SortState {
  columnId: string;
  direction: SortDirection;
}

export interface TableColumn<Row> {
  id: string;
  header: React.ReactNode;
  /** Renders the cell. Return the "not measured" element for a missing value. */
  cell: (row: Row) => React.ReactNode;
  sortable?: boolean;
  /** Right-aligns the column. Use for every numeric column. */
  numeric?: boolean;
  width?: string;
  /** Read by a screen reader in place of a header that is only an icon. */
  headerLabel?: string;
}

export type TableDensity = 'comfortable' | 'compact';

export interface TableProps<Row> {
  columns: Array<TableColumn<Row>>;
  rows: Row[];
  rowKey: (row: Row) => string;
  /** Names the table for a screen reader. Required. */
  caption: string;
  /** Shows the caption above the table instead of only to a reader. */
  showCaption?: boolean;
  sort?: SortState | null;
  onSortChange?: (sort: SortState) => void;
  density?: TableDensity;
  selectedKeys?: string[];
  onSelectionChange?: (keys: string[]) => void;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  empty?: React.ReactNode;
  className?: string;
}

const DENSITY_PADDING: Record<TableDensity, string> = {
  comfortable: 'px-3 py-2.5',
  compact: 'px-3 py-1'
};

/**
 * The table the console reads its fleet from.
 *
 * Sorting is announced through aria-sort on the header cell and driven by a
 * real button inside it, so it works from the keyboard and a reader is told
 * which column is sorted and which way. Numbers are tabular so columns line up.
 * Loading, error and empty are slots of the table rather than something each
 * page invents.
 */
export function Table<Row>({
  columns,
  rows,
  rowKey,
  caption,
  showCaption = false,
  sort,
  onSortChange,
  density = 'comfortable',
  selectedKeys,
  onSelectionChange,
  loading = false,
  error = null,
  onRetry,
  empty,
  className
}: TableProps<Row>) {
  const { t } = useTranslation('ui');
  const captionId = useId();
  const selectable = Boolean(onSelectionChange);
  const selected = useMemo(() => new Set(selectedKeys ?? []), [selectedKeys]);

  const toggleRow = useCallback(
    (key: string) => {
      if (!onSelectionChange) return;
      const next = new Set(selected);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      onSelectionChange([...next]);
    },
    [onSelectionChange, selected]
  );

  const allKeys = rows.map(rowKey);
  const allSelected = allKeys.length > 0 && allKeys.every((key) => selected.has(key));
  const someSelected = allKeys.some((key) => selected.has(key)) && !allSelected;

  const toggleAll = useCallback(() => {
    if (!onSelectionChange) return;
    onSelectionChange(allSelected ? [] : allKeys);
    // allKeys is derived from rows on every render; recomputing here is cheaper
    // than memoising a list that changes whenever the fleet does.
  }, [allSelected, allKeys, onSelectionChange]);

  const requestSort = useCallback(
    (columnId: string) => {
      if (!onSortChange) return;
      const direction: SortDirection = sort?.columnId === columnId && sort.direction === 'asc' ? 'desc' : 'asc';
      onSortChange({ columnId, direction });
    },
    [onSortChange, sort]
  );

  if (error) return <ErrorState detail={error} onRetry={onRetry} className={className} />;

  return (
    <div className={cn('w-full overflow-auto rounded-card border border-border', className)}>
      {loading && (
        <span role="status" className="sr-only">
          {t('loading.label')}
        </span>
      )}
      <table className="w-full border-collapse text-body" aria-describedby={captionId}>
        <caption
          id={captionId}
          className={cn('px-3 py-2 text-left text-caption text-muted', !showCaption && 'sr-only')}
        >
          {caption}
          {selectable && selected.size > 0 && (
            <span className="ml-2 text-accent">{t('table.selectedCount', { count: selected.size })}</span>
          )}
        </caption>

        <thead className="sticky top-0 z-base bg-surface-sunken">
          <tr>
            {selectable && (
              <th scope="col" className={cn('w-10', DENSITY_PADDING[density])}>
                <Checkbox
                  aria-label={t('table.selectAll')}
                  checked={allSelected}
                  indeterminate={someSelected}
                  onChange={toggleAll}
                />
              </th>
            )}
            {columns.map((column) => {
              const isSorted = sort?.columnId === column.id;
              const ariaSort = !column.sortable
                ? undefined
                : isSorted
                  ? sort.direction === 'asc'
                    ? 'ascending'
                    : 'descending'
                  : 'none';
              return (
                <th
                  key={column.id}
                  scope="col"
                  aria-sort={ariaSort}
                  style={column.width ? { width: column.width } : undefined}
                  className={cn(
                    'border-b border-border text-caption font-semibold uppercase tracking-wide text-muted',
                    column.numeric ? 'text-right' : 'text-left',
                    DENSITY_PADDING[density]
                  )}
                >
                  {column.sortable && onSortChange ? (
                    <button
                      type="button"
                      onClick={() => requestSort(column.id)}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-sm font-semibold uppercase tracking-wide',
                        'hover:text-content focus-visible:outline-focus',
                        column.numeric && 'flex-row-reverse'
                      )}
                    >
                      <span>{column.headerLabel ?? column.header}</span>
                      {isSorted ? (
                        sort.direction === 'asc' ? (
                          <ChevronUp aria-hidden="true" className="h-3.5 w-3.5 text-accent" />
                        ) : (
                          <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 text-accent" />
                        )
                      ) : (
                        <ChevronsUpDown aria-hidden="true" className="h-3.5 w-3.5 opacity-60" />
                      )}
                      <span className="sr-only">
                        {isSorted
                          ? sort.direction === 'asc'
                            ? t('table.sortedAscending')
                            : t('table.sortedDescending')
                          : t('table.notSorted')}
                      </span>
                    </button>
                  ) : (
                    (column.headerLabel ?? column.header)
                  )}
                </th>
              );
            })}
          </tr>
        </thead>

        <tbody>
          {loading && rows.length === 0 && (
            <tr>
              <td colSpan={columns.length + (selectable ? 1 : 0)} className="p-4">
                <Skeleton lines={4} />
              </td>
            </tr>
          )}

          {!loading &&
            rows.map((row) => {
              const key = rowKey(row);
              const isSelected = selected.has(key);
              return (
                <tr
                  key={key}
                  data-selected={isSelected || undefined}
                  className={cn(
                    'border-b border-border-subtle last:border-b-0 hover:bg-surface-hover',
                    isSelected && 'bg-accent-subtle'
                  )}
                >
                  {selectable && (
                    <td className={DENSITY_PADDING[density]}>
                      <Checkbox
                        aria-label={`${t('table.selectRow')}: ${key}`}
                        checked={isSelected}
                        onChange={() => toggleRow(key)}
                      />
                    </td>
                  )}
                  {columns.map((column) => (
                    <td
                      key={column.id}
                      className={cn(
                        'align-middle text-content',
                        column.numeric && 'text-right tabular-nums',
                        DENSITY_PADDING[density]
                      )}
                    >
                      {column.cell(row)}
                    </td>
                  ))}
                </tr>
              );
            })}
        </tbody>
      </table>

      {!loading && rows.length === 0 && <div className="p-4">{empty ?? <EmptyState className="border-0" />}</div>}
    </div>
  );
}

/** Sorts rows by a comparable key, keeping missing values last in both directions. */
export function sortRows<Row>(rows: Row[], value: (row: Row) => unknown, direction: SortDirection): Row[] {
  const factor = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = value(a);
    const right = value(b);
    const leftMissing = left === null || left === undefined;
    const rightMissing = right === null || right === undefined;
    // A node that never reported is not the smallest value; it is not on the
    // scale at all, so it sits at the end whichever way the column is sorted.
    if (leftMissing && rightMissing) return 0;
    if (leftMissing) return 1;
    if (rightMissing) return -1;
    if (typeof left === 'number' && typeof right === 'number') return (left - right) * factor;
    return String(left).localeCompare(String(right)) * factor;
  });
}
