import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult
} from '@tanstack/react-query';

import { apiDelete, apiGet, apiPost, apiPut, type ApiError } from '../apiClient';
import type { ProfileDeviceResponse } from '../../devices/wgConfig';
/** The fleet list key, declared here so this file does not depend on keys.ts (same value: ['nodes']). */
const nodesKey = ['nodes'] as const;

/*
 * Hooks for the device endpoints the user portal and the admin dialog use.
 * Imported by path (not through queries/index.ts), and their keys stay local
 * per the plan's file rules.
 */

export interface RegisterProfileDeviceInput {
  name: string;
  public_key: string;
  preshared_key: string;
  /** ADR 0032: send all the device's traffic through this exit. Omitted for an overlay-only profile. */
  exit_node_id?: string;
}

export interface ProfileExit {
  node_id: string;
  name: string;
  kind: 'gateway' | 'node';
  online: boolean;
}

export interface ProfileExitsResponse {
  can_choose: boolean;
  self_service: boolean;
  exits: ProfileExit[];
}

/** The exits the caller's devices may use, and whether the caller may choose one. */
export function useProfileExits(): UseQueryResult<ProfileExitsResponse, ApiError> {
  return useQuery({
    queryKey: ['devices', 'exits'],
    queryFn: ({ signal }) => apiGet<ProfileExitsResponse>('/devices/exits', { signal }),
    staleTime: 30_000
  });
}

export interface RegistrationKey {
  id: string;
  key_prefix?: string;
  expires_at?: string;
  enrolment_string: string;
}

/**
 * Registers a phone or computer from the public key the browser made. Only
 * the fields named here are sent (the exit only when one was chosen): the
 * private key is never part of a request.
 */
export function useRegisterProfileDevice(): UseMutationResult<
  ProfileDeviceResponse,
  ApiError,
  RegisterProfileDeviceInput
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, public_key, preshared_key, exit_node_id }: RegisterProfileDeviceInput) =>
      apiPost<ProfileDeviceResponse>(
        '/devices/profile',
        exit_node_id ? { name, public_key, preshared_key, exit_node_id } : { name, public_key, preshared_key }
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: nodesKey });
    }
  });
}

/** One gateway for WireGuard-app devices, as GET /api/devices/gateways answers it. */
export interface ProfileGateway {
  node_id: string;
  name: string;
  /** The host:port a profile names as its peer's Endpoint. */
  endpoint: string;
  /** The gateway's WireGuard public key (base64), what a profile's [Peer] carries. */
  public_key: string | null;
  /** The gateway new devices join unless an administrator chooses another. */
  is_default: boolean;
  /** How many WireGuard-app devices it serves now. */
  devices: number;
  online: boolean;
  overlay_ipv4?: string | null;
  /** Its last heartbeat; null when it never sent one. */
  last_seen_at: string | null;
}

const gatewaysKey = ['devices', 'gateways'] as const;

/** The organisation's gateways, the default first. */
export function useProfileGateways(): UseQueryResult<ProfileGateway[], ApiError> {
  return useQuery({
    queryKey: gatewaysKey,
    queryFn: async ({ signal }) => {
      const answer = await apiGet<{ gateways?: ProfileGateway[] }>('/devices/gateways', { signal });
      return Array.isArray(answer?.gateways) ? answer.gateways : [];
    },
    staleTime: 15_000
  });
}

function useGatewayMutation<TData, TInput>(
  mutationFn: (input: TInput) => Promise<TData>
): UseMutationResult<TData, ApiError, TInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: gatewaysKey });
      void queryClient.invalidateQueries({ queryKey: nodesKey });
    }
  });
}

/** Makes a node a gateway for profile devices, or changes its endpoint. Admins only. */
export function useSetProfileGateway() {
  return useGatewayMutation(({ node_id, endpoint }: { node_id: string; endpoint: string }) =>
    apiPut<{ gateway: Omit<ProfileGateway, 'devices' | 'online' | 'last_seen_at'> }>('/devices/gateway', {
      node_id,
      endpoint
    })
  );
}

/** Makes a gateway the one new devices join. Admins only. */
export function useMakeDefaultGateway() {
  return useGatewayMutation((nodeId: string) =>
    apiPut<{ gateway: ProfileGateway }>(`/devices/gateways/${encodeURIComponent(nodeId)}/default`, {})
  );
}

/** Stops a node serving profile devices. Refused (409) while it serves any, or while it is the default. */
export function useRemoveGateway() {
  return useGatewayMutation((nodeId: string) =>
    apiDelete<{ removed: string }>(`/devices/gateways/${encodeURIComponent(nodeId)}`)
  );
}

export interface MoveDeviceAnswer {
  device_id: string;
  gateway: { node_id: string; name: string; public_key: string | null; endpoint: string };
  /** True when the gateway changed: the device needs a new profile naming it. */
  reimport_required: boolean;
}

/** Moves a WireGuard-app device to another gateway of its organisation. Admins only. */
export function useMoveDeviceGateway() {
  return useGatewayMutation(({ deviceId, gatewayId }: { deviceId: string; gatewayId: string }) =>
    apiPut<MoveDeviceAnswer>(`/devices/${encodeURIComponent(deviceId)}/gateway`, { gateway_node_id: gatewayId })
  );
}

/** A single-use key, valid for 24 hours, that a device enrols with. */
export function useCreateRegistrationKey(): UseMutationResult<RegistrationKey, ApiError, void> {
  return useMutation({
    mutationFn: () => apiPost<RegistrationKey>('/preauth-keys', { expires_in_hours: 24, is_reusable: false })
  });
}
