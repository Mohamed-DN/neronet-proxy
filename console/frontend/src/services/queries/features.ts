import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { apiRequest, ApiError } from '../apiClient';
import { parseFeatures } from '../features.js';
import type { Features } from '../types';
import { queryKeys } from './keys';

const ALL_OFF: Features = { cloud_pc: false };

/**
 * Which optional features the server has switched on.
 *
 * The console does not decide this and does not guess it. A failed request
 * reads as "all off": a menu entry for something the server has switched off
 * leads to a page whose every request is a 404, which is worse than an entry
 * that is not there. The answer is loaded once per session and not polled.
 */
export function useFeatures(): UseQueryResult<Features, Error> {
  return useQuery({
    queryKey: queryKeys.features,
    queryFn: async ({ signal }) => {
      try {
        return parseFeatures(await apiRequest<unknown>('/features', { signal })) as Features;
      } catch (err) {
        if (err instanceof ApiError) return ALL_OFF;
        throw err;
      }
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false
  });
}
