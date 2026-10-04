import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import { apiRequest } from '../apiClient';
import { storeAccessToken } from '../authToken';
import type { Compartment, CompartmentPeering, TopologyData } from '../types';
import { queryKeys } from './keys';

/**
 * Sub-networks. A compartment is enforced in the data plane (ADR 0021): its devices
 * reach each other, and another compartment only through an "allow" peering. Every
 * change below alters who reaches whom, so each one refreshes the topology and the
 * compiled-policy views along with the compartment lists.
 */
function useSubnetMutation<TVariables, TResult>(mutationFn: (vars: TVariables) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.compartments });
      queryClient.invalidateQueries({ queryKey: queryKeys.statsTopology });
      queryClient.invalidateQueries({ queryKey: queryKeys.acl });
    }
  });
}

export function useCompartmentPeerings(): UseQueryResult<CompartmentPeering[], Error> {
  return useQuery({
    queryKey: queryKeys.compartmentPeerings,
    queryFn: async ({ signal }) => {
      const res = await apiRequest<{ peerings: CompartmentPeering[] }>('/compartments/peerings/list', { signal });
      return res?.peerings ?? [];
    },
    staleTime: 15_000
  });
}

export function useCreateCompartment() {
  return useSubnetMutation(async (name: string) => {
    const res = await apiRequest<{ compartment: Compartment }>('/compartments', { method: 'POST', body: { name } });
    return res.compartment;
  });
}

export function useDeleteCompartment() {
  return useSubnetMutation((id: string) =>
    apiRequest<{ success: boolean }>(`/compartments/${encodeURIComponent(id)}`, { method: 'DELETE' })
  );
}

/** Move devices into a compartment. Moving them into the default one takes them out of a sub-network. */
export function useMoveToCompartment() {
  return useSubnetMutation(async ({ compartmentId, nodeIds }: { compartmentId: string; nodeIds: string[] }) => {
    const res = await apiRequest<{ moved: string[] }>(`/compartments/${encodeURIComponent(compartmentId)}/members`, {
      method: 'POST',
      body: { node_ids: nodeIds }
    });
    return res.moved;
  });
}

export function useConnectCompartments() {
  return useSubnetMutation(({ a, b }: { a: string; b: string }) =>
    apiRequest<{ peering: CompartmentPeering }>('/compartments/peerings/create', {
      method: 'POST',
      body: { src_compartment_id: a, dst_compartment_id: b, policy: 'allow' }
    })
  );
}

export function useDisconnectCompartments() {
  return useSubnetMutation((peeringId: string) =>
    apiRequest<{ success: boolean }>(`/compartments/peerings/${encodeURIComponent(peeringId)}`, { method: 'DELETE' })
  );
}

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
      queryClient.invalidateQueries({ queryKey: queryKeys.acl });
    }
  });
}

/**
 * Reconnect all severed mesh links and remove explicit isolation rules.
 */
export function useReconnectAllTopologyLinks() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      return apiRequest<{ success: boolean; message: string }>('/stats/topology/reconnect-all', {
        method: 'POST'
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.statsTopology });
      queryClient.invalidateQueries({ queryKey: queryKeys.acl });
    }
  });
}
