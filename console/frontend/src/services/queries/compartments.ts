import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import { apiRequest } from '../apiClient';
import { storeAccessToken } from '../authToken';
import type { Compartment, TopologyData } from '../types';
import { queryKeys } from './keys';

/**
 * List L2 network compartments.
 * Hidden ghost vaults are omitted unless root access tier is active.
 */
export function useCompartments(): UseQueryResult<Compartment[], Error> {
  return useQuery({
    queryKey: queryKeys.compartments,
    queryFn: async ({ signal }) => {
      const res = await apiRequest<{ compartments: Compartment[] }>('/compartments', { signal });
      return res?.compartments ?? [];
    },
    staleTime: 15_000,
    refetchInterval: 30_000
  });
}

/**
 * Interactive mesh network topology nodes and links.
 * Hidden ghost vault nodes are omitted unless root access tier is active.
 */
export function useTopology(): UseQueryResult<TopologyData, Error> {
  return useQuery({
    queryKey: queryKeys.statsTopology,
    queryFn: ({ signal }) => apiRequest<TopologyData>('/stats/topology', { signal }),
    staleTime: 15_000,
    refetchInterval: 30_000
  });
}

export interface VaultUnlockResponse {
  success: boolean;
  compartment_access: string;
  token?: string;
  error?: string;
}

/**
 * Elevate session to root tier to unlock secret Ghost Vaults.
 */
export function useUnlockGhostVaults() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (password: string) => {
      const res = await apiRequest<VaultUnlockResponse>('/compartments/unlock', {
        method: 'POST',
        body: { password }
      });
      if (res?.token) {
        storeAccessToken(res.token);
      }
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.statsTopology });
      queryClient.invalidateQueries({ queryKey: queryKeys.compartments });
      queryClient.invalidateQueries({ queryKey: queryKeys.nodes });
      queryClient.invalidateQueries({ queryKey: queryKeys.statsOverview });
    }
  });
}

/**
 * Revert session to standard tier to lock Ghost Vaults.
 */
export function useLockGhostVaults() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const res = await apiRequest<VaultUnlockResponse>('/compartments/lock', {
        method: 'POST'
      });
      if (res?.token) {
        storeAccessToken(res.token);
      }
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.statsTopology });
      queryClient.invalidateQueries({ queryKey: queryKeys.compartments });
      queryClient.invalidateQueries({ queryKey: queryKeys.nodes });
      queryClient.invalidateQueries({ queryKey: queryKeys.statsOverview });
    }
  });
}

export interface UpdateTopologyLinkPayload {
  source_node_id: string;
  target_node_id: string;
  mode: 'direct' | 'derp' | 'openvpn' | 'onion';
  relay_id?: string | null;
  is_visible?: boolean;
}

/**
 * Configure peer-to-peer routing mode or toggle mesh visibility between two nodes.
 */
export function useUpdateTopologyLink() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: UpdateTopologyLinkPayload) => {
      return apiRequest<{ success: boolean; link: unknown }>('/stats/topology/link', {
        method: 'POST',
        body: payload
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.statsTopology });
      queryClient.invalidateQueries({ queryKey: queryKeys.acls });
    }
  });
}
