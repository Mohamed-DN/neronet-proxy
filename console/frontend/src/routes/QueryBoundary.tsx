import { useTranslation } from 'react-i18next';
import type { UseQueryResult } from '@tanstack/react-query';

import { ApiError } from '../services/apiClient';
import { EmptyState, ErrorState, Skeleton } from '../ui';

/**
 * The one way a page renders a query.
 *
 * The five states from the design system are the only things a surface shows
 * besides its data, and this decides which one, so that no page has to and no
 * two pages disagree.
 *
 * The order matters. A failed query still holds whatever it last fetched, and
 * drawing that is how a console ends up reporting a healthy fleet long after
 * the control plane stopped answering. The error wins over the data.
 */

export type QueryStateKind = 'loading' | 'error' | 'empty' | 'ready';

export function queryStateOf<T>(
  query: Pick<UseQueryResult<T, Error>, 'status' | 'data'>,
  isEmpty?: (data: T) => boolean
): QueryStateKind {
  if (query.status === 'error') return 'error';
  if (query.status === 'pending' || query.data === undefined) return 'loading';
  if (isEmpty ? isEmpty(query.data) : Array.isArray(query.data) && query.data.length === 0) return 'empty';
  return 'ready';
}

export interface QueryBoundaryProps<T> {
  query: UseQueryResult<T, Error>;
  children: (data: T) => React.ReactNode;
  /** Defaults to "an empty array is empty". */
  isEmpty?: (data: T) => boolean;
  /** Replaces the default empty surface. */
  emptyTitle?: string;
  emptyBody?: React.ReactNode;
  /** Number of skeleton lines while loading. */
  loadingLines?: number;
}

export function QueryBoundary<T>({
  query,
  children,
  isEmpty,
  emptyTitle,
  emptyBody,
  loadingLines = 4
}: QueryBoundaryProps<T>) {
  const { t } = useTranslation('ui');
  const state = queryStateOf(query, isEmpty);

  if (state === 'loading') {
    return (
      <div>
        <p className="sr-only" role="status">
          {t('state.loading')}
        </p>
        <Skeleton lines={loadingLines} />
      </div>
    );
  }

  if (state === 'error') {
    const error = query.error;
    const detail = error instanceof ApiError && error.isUnreachable ? t('error.unreachable') : (error?.message ?? null);
    return <ErrorState detail={detail} onRetry={() => void query.refetch()} />;
  }

  if (state === 'empty') {
    return <EmptyState title={emptyTitle} body={emptyBody} />;
  }

  return <>{children(query.data as T)}</>;
}
