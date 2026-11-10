import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult
} from '@tanstack/react-query';

import { apiGet, apiPost, type ApiError } from '../apiClient';

const riskKey = ['risk'] as const;
const nodesKey = ['nodes'] as const;

/** The distribution and average the engine computed. A missing field stays missing. */
export interface RiskSummary {
  distribution?: { low?: number | null; medium?: number | null; high?: number | null };
  average_risk_score?: number | null;
  total_nodes?: number | null;
  quarantined_nodes?: number | null;
}

/** One device with a score above zero, as `GET /risk/leaderboard` lists it. */
export interface RiskRow {
  node_id: string;
  id?: string;
  name?: string | null;
  risk_score: number;
  is_quarantined: boolean;
  status?: string;
}

/** One security event that bears on risk, from the audit ledger. */
export interface RiskEvent {
  id: string | number;
  event_type: string;
  node_id?: string | null;
  actor?: string | null;
  severity?: string | null;
  details?: string | null;
  created_at?: string | null;
  risk_delta?: number | null;
}

function bodyOf<T>(value: unknown, field: string): T {
  if (value === null || typeof value !== 'object') {
    throw new Error(`The control plane returned no ${field}`);
  }
  return value as T;
}

export function useRiskSummary(): UseQueryResult<RiskSummary, Error> {
  return useQuery({
    queryKey: [...riskKey, 'summary'],
    queryFn: async ({ signal }) => bodyOf<RiskSummary>(await apiGet('/risk/summary', { signal }), 'summary'),
    staleTime: 15_000
  });
}

/** Highest scores first, up to `limit`. Devices at zero are not on the list. */
export function useRiskLeaderboard(limit = 100): UseQueryResult<RiskRow[], Error> {
  return useQuery({
    queryKey: [...riskKey, 'leaderboard', limit],
    queryFn: async ({ signal }) => {
      const body = await apiGet<{ leaderboard?: RiskRow[] }>(`/risk/leaderboard?limit=${limit}`, { signal });
      if (!Array.isArray(body?.leaderboard)) throw new Error('The control plane returned no leaderboard');
      return body.leaderboard;
    },
    staleTime: 15_000
  });
}

export function useRiskEvents(limit = 50): UseQueryResult<RiskEvent[], Error> {
  return useQuery({
    queryKey: [...riskKey, 'events', limit],
    queryFn: async ({ signal }) => {
      const body = await apiGet<{ events?: RiskEvent[] }>(`/risk/events?limit=${limit}`, { signal });
      if (!Array.isArray(body?.events)) throw new Error('The control plane returned no events');
      return body.events;
    },
    staleTime: 15_000
  });
}

/**
 * Blocks a device through the node action the server already has. The server
 * records the reason in the activity log, so the caller passes it in the
 * operator's language.
 */
export function useBlockDevice(): UseMutationResult<unknown, ApiError, { id: string; reason: string }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      apiPost(`/nodes/${encodeURIComponent(id)}/action`, { action: 'quarantine', params: { reason } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: riskKey });
      void queryClient.invalidateQueries({ queryKey: nodesKey });
    }
  });
}
