import { useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';

import { apiGet, apiPost, apiPut, type ApiError } from '../apiClient';
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

/** Names the node that serves profile devices and the endpoint phones dial. Admins only. */
export function useSetProfileGateway(): UseMutationResult<
  { gateway: { node_id: string; public_key: string; endpoint: string } },
  ApiError,
  { node_id: string; endpoint: string }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ node_id, endpoint }: { node_id: string; endpoint: string }) =>
      apiPut<{ gateway: { node_id: string; public_key: string; endpoint: string } }>('/devices/gateway', {
        node_id,
        endpoint
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: nodesKey });
    }
  });
}

/** A single-use key, valid for 24 hours, that a device enrols with. */
export function useCreateRegistrationKey(): UseMutationResult<RegistrationKey, ApiError, void> {
  return useMutation({
    mutationFn: () => apiPost<RegistrationKey>('/preauth-keys', { expires_in_hours: 24, is_reusable: false })
  });
}
