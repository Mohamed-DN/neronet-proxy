import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import { apiRequest } from '../apiClient';
import { captureSession, isCurrentCredential, readAccessToken, storeAccessToken } from '../authToken';
import { BROWSER_PROTOCOL, beginBrowserOperation, rememberSelection, type Selection } from '../browserContext';
import type {
  Compartment,
  CompartmentPeering,
  LineColour,
  MergeCompartmentResult,
  ReachPreview,
  SplitCompartmentResult,
  TopologyData
} from '../types';
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

/**
 * Rename a line, give it a colour, or set its position. Colour and order are display
 * only; a rename is 409 `name_in_use` when another line has the name. Send only the
 * fields that change; `line_colour: null` goes back to automatic.
 */
export interface UpdateCompartmentInput {
  id: string;
  name?: string;
  line_colour?: LineColour | null;
  sort_order?: number;
}

export function useUpdateCompartment() {
  return useSubnetMutation(async ({ id, ...changes }: UpdateCompartmentInput) => {
    const res = await apiRequest<{ compartment: Compartment }>(`/compartments/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: changes
    });
    return res.compartment;
  });
}

/** Put the lines in this order (first id first). Returns the new list. */
export function useReorderCompartments() {
  return useSubnetMutation(async (ids: string[]) => {
    const res = await apiRequest<{ compartments: Compartment[] }>('/compartments/reorder', {
      method: 'PUT',
      body: { ids }
    });
    return res.compartments;
  });
}

/**
 * Split devices off a line into a new one, in one step. The new line starts with no
 * peerings; the result says how many the source has that it did not get.
 */
export function useSplitCompartment() {
  return useSubnetMutation(
    ({ id, name, nodeIds, lineColour }: { id: string; name: string; nodeIds: string[]; lineColour?: LineColour }) =>
      apiRequest<SplitCompartmentResult>(`/compartments/${encodeURIComponent(id)}/split`, {
        method: 'POST',
        body: { name, node_ids: nodeIds, ...(lineColour ? { line_colour: lineColour } : {}) }
      })
  );
}

/**
 * Merge a line into another. Its devices move over, its peerings are dropped (the result
 * counts and names them) and the line is deleted.
 */
export function useMergeCompartment() {
  return useSubnetMutation(({ id, into }: { id: string; into: string }) =>
    apiRequest<MergeCompartmentResult>(`/compartments/${encodeURIComponent(id)}/merge`, {
      method: 'POST',
      body: { into }
    })
  );
}

/**
 * What moving devices into a line would change, with nothing written. A mutation because
 * it is asked for on demand with the editor's current selection, not cached.
 */
export function usePreviewMove() {
  return useMutation({
    mutationFn: ({ nodeIds, to }: { nodeIds: string[]; to: string }) =>
      apiRequest<ReachPreview>('/compartments/preview-move', { method: 'POST', body: { node_ids: nodeIds, to } })
  });
}

/** What splitting devices off a line would change, with nothing written. */
export function usePreviewSplit() {
  return useMutation({
    mutationFn: ({ id, nodeIds }: { id: string; nodeIds: string[] }) =>
      apiRequest<ReachPreview>(`/compartments/${encodeURIComponent(id)}/preview-split`, {
        method: 'POST',
        body: { node_ids: nodeIds }
      })
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
  /** Browser-v2: the rotated issuance, selected atomically by the server. */
  selected?: Selection;
  error?: string;
}

/**
 * Vault unlock/lock rotate the session. In browser-v2 the rotation is admitted by
 * an intent expecting the current issuance and returns only its successor selector.
 */
async function changeVault(path: string, kind: 'unlock' | 'lock', body: Record<string, unknown>) {
  if (BROWSER_PROTOCOL) {
    const snapshot = captureSession();
    const operation = await beginBrowserOperation(kind, readAccessToken());
    const res = await apiRequest<VaultUnlockResponse>(path, {
      method: 'POST',
      body: { ...body, operation_id: operation.operation_id }
    });
    // A response that lands after a newer sign-in must not overwrite its selection.
    if (res?.selected && isCurrentCredential(snapshot)) {
      await rememberSelection(res.selected);
      storeAccessToken(res.selected.issuance_id);
    }
    return res;
  }
  // Legacy clients keep the exact earlier request shape (no body for lock).
  const res = await apiRequest<VaultUnlockResponse>(path, {
    method: 'POST',
    body: Object.keys(body).length ? body : undefined
  });
  if (res?.token) storeAccessToken(res.token);
  return res;
}

/**
 * Elevate session to root tier to unlock secret Ghost Vaults.
 */
export function useUnlockGhostVaults() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (password: string) => changeVault('/compartments/unlock', 'unlock', { password }),
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
    mutationFn: () => changeVault('/compartments/lock', 'lock', {}),
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
