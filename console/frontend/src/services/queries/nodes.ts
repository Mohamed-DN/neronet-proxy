import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import { apiPost, apiRequest } from '../apiClient';
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

export interface PingResult {
  rtt_ms: number;
  jitter_ms: number;
  status: string;
}

/**
 * Quarantines a node, revoking its active WireGuard peer status across the mesh.
 */
export function useQuarantineNode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason?: string }) => {
      return apiPost<{ success: boolean; result?: unknown }>(`/nodes/${encodeURIComponent(id)}/quarantine`, { reason });
    },
    onSuccess: (_, { id }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.nodes });
      void queryClient.invalidateQueries({ queryKey: queryKeys.node(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.statsOverview });
    }
  });
}

/**
 * Restores a quarantined node to active fleet status.
 */
export function useLiftQuarantineNode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      return apiPost<{ success: boolean; result?: unknown }>(`/nodes/${encodeURIComponent(id)}/unquarantine`, {});
    },
    onSuccess: (_, { id }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.nodes });
      void queryClient.invalidateQueries({ queryKey: queryKeys.node(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.statsOverview });
    }
  });
}

/**
 * Cryptographically revokes a node's key permanently, deleting the node registration
 * and blacklisting its public key across all mesh peers.
 */
export function useRevokeNode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason?: string }) => {
      return apiPost<{ success: boolean; message?: string }>(`/nodes/${encodeURIComponent(id)}/revoke`, { reason });
    },
    onSuccess: (_, { id }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.nodes });
      void queryClient.invalidateQueries({ queryKey: queryKeys.node(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.statsOverview });
    }
  });
}

/**
 * Performs a live latency RTT & jitter probe to a node.
 */
export function useNodePing() {
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await apiPost<{ success: boolean; result: PingResult }>(`/nodes/${encodeURIComponent(id)}/action`, {
        action: 'ping'
      });
      return res.result;
    }
  });
}
