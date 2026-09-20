import { QueryClient } from '@tanstack/react-query';

import { ApiError } from '../apiClient';

/**
 * The cache the whole console shares.
 *
 * Defaults worth stating. A 4xx is never retried: the control plane has
 * answered, and asking again with the same argument gets the same answer while
 * spending an operator's attention on a spinner. A transport failure is retried
 * twice, because a control plane restart is a second or two.
 *
 * A query that has failed still carries the last answer it received, which is
 * how TanStack Query is meant to work and is exactly what must not reach the
 * screen here: a console that keeps drawing the fleet it saw ten minutes ago is
 * a console reporting a mesh that may no longer exist. `QueryBoundary` puts the
 * error ahead of the data for that reason, and is the only thing pages render a
 * query through.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: true,
        retry(failureCount: number, error: unknown) {
          if (error instanceof ApiError && error.isClientError) return false;
          return failureCount < 2;
        }
      },
      mutations: {
        retry: false
      }
    }
  });
}
