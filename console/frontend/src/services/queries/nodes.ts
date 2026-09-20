import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { apiRequest } from '../apiClient';
import type { MeshNode } from '../types';
import { queryKeys } from './keys';

/**
 * A node counts as reachable when the control plane heard from it inside the
 * liveness window, which is four of its fifteen-second heartbeat intervals.
 */
export const LIVENESS_WINDOW_MS = 60_000;

export function isReachable(node: MeshNode, now = Date.now()): boolean {
  if (!node.last_heartbeat) return false;
  const heard = new Date(node.last_heartbeat).getTime();
  return Number.isFinite(heard) && now - heard < LIVENESS_WINDOW_MS;
}

async function fetchNodes(signal: AbortSignal): Promise<MeshNode[]> {
  const body = await apiRequest<{ nodes?: MeshNode[] } | MeshNode[]>('/nodes', { signal });
  if (Array.isArray(body)) return body;
  return Array.isArray(body?.nodes) ? body.nodes : [];
}

/**
 * The fleet.
 *
 * Refetched on an interval as well as on live events, because reachability is
 * computed from `last_heartbeat` against the current clock: a list fetched once
 * and never refreshed ages out of the liveness window and reports the whole
 * fleet down without a single request failing.
 */
export function useNodes(): UseQueryResult<MeshNode[], Error> {
  return useQuery({
    queryKey: queryKeys.nodes,
    queryFn: ({ signal }) => fetchNodes(signal),
    staleTime: 15_000,
    refetchInterval: 30_000
  });
}

export function useNode(id: string | undefined): UseQueryResult<MeshNode, Error> {
  return useQuery({
    queryKey: queryKeys.node(id ?? ''),
    enabled: Boolean(id),
    queryFn: async ({ signal }) => {
      const body = await apiRequest<{ node?: MeshNode }>(`/nodes/${encodeURIComponent(id as string)}`, { signal });
      if (!body?.node) throw new Error('The control plane returned no node for this identifier');
      return body.node;
    },
    staleTime: 15_000
  });
}

export interface FleetCounts {
  total: number;
  reachable: number;
  quarantined: number;
  highRisk: number;
}

/**
 * The four figures the sidebar shows.
 *
 * `highRisk` counts only nodes that carry a score. A node that was never scored
 * is not a low-risk node, and `(score || 0) > 75` quietly made it one.
 */
export function fleetCounts(nodes: MeshNode[] | undefined, now = Date.now()): FleetCounts {
  const list = nodes ?? [];
  return {
    total: list.length,
    reachable: list.filter((n) => isReachable(n, now)).length,
    quarantined: list.filter((n) => Boolean(n.is_quarantined)).length,
    highRisk: list.filter((n) => typeof n.risk_score === 'number' && n.risk_score > 75).length
  };
}
