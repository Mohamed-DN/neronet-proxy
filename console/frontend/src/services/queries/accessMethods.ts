import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult
} from '@tanstack/react-query';

import { apiGet, apiPost, apiPut, type ApiError } from '../apiClient';

/*
 * The organisation's access methods (ADR 0036). The answers carry switches only: the
 * AmneziaWG parameters never leave the server through these endpoints.
 */

export interface AccessMethodsSettings {
  organization_id: string;
  wireguard_wss: boolean;
  amneziawg: boolean;
  /** The parameters exist (generated when AmneziaWG was first switched on). */
  amneziawg_ready: boolean;
  /** VLESS + REALITY is allowed. Absent on an older server: off. */
  vless?: boolean;
  /** The REALITY keys exist (generated when VLESS was first switched on). */
  vless_ready?: boolean;
}

/** What the switches are set to, as the server takes them. `vless` absent leaves it as it is. */
export interface AccessMethodsInput {
  wireguard_wss: boolean;
  amneziawg: boolean;
  vless?: boolean;
}

/** Who switching a method off would affect (the server's simulation, nothing written). */
export interface AccessMethodsPlan {
  /** Devices left with no way to connect: the server refuses the change. */
  strands: Array<{ id: string; name: string | null }>;
  strands_total: number;
  /** Devices whose profile was made for the method: they must download a new one. */
  reimport: Array<{ id: string; name: string | null; access_method: string }>;
  reimport_total: number;
}

export interface RegenerateResult extends AccessMethodsSettings {
  /** How many AmneziaWG devices must import their profile again. */
  devices_to_redo: number;
}

const keyFor = (orgId: string) => ['organizations', orgId, 'access-methods'] as const;
const base = (orgId: string) => `/organizations/${encodeURIComponent(orgId)}/access-methods`;

export function useAccessMethods(orgId: string | null): UseQueryResult<AccessMethodsSettings, ApiError> {
  return useQuery({
    queryKey: keyFor(orgId ?? ''),
    enabled: Boolean(orgId),
    queryFn: ({ signal }) => apiGet<AccessMethodsSettings>(base(orgId ?? ''), { signal })
  });
}

export function useSetAccessMethods(
  orgId: string
): UseMutationResult<
  AccessMethodsSettings,
  ApiError,
  AccessMethodsInput & { confirm_reimport?: boolean }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input) => apiPut<AccessMethodsSettings>(base(orgId), input),
    onSuccess: (data) => {
      const settings: AccessMethodsSettings & { plan?: unknown } = { ...data };
      delete settings.plan;
      queryClient.setQueryData(keyFor(orgId), settings);
      void queryClient.invalidateQueries({ queryKey: ['devices', 'profile-methods'] });
      void queryClient.invalidateQueries({ queryKey: ['connection-order'] });
    }
  });
}

export function usePreviewAccessMethods(
  orgId: string
): UseMutationResult<AccessMethodsPlan, ApiError, AccessMethodsInput> {
  return useMutation({ mutationFn: (input) => apiPost<AccessMethodsPlan>(`${base(orgId)}/preview`, input) });
}

export function useRegenerateAwgParams(orgId: string): UseMutationResult<RegenerateResult, ApiError, void> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<RegenerateResult>(`${base(orgId)}/regenerate`, {}),
    onSuccess: (data) => {
      queryClient.setQueryData(keyFor(orgId), {
        organization_id: data.organization_id,
        wireguard_wss: data.wireguard_wss,
        amneziawg: data.amneziawg,
        amneziawg_ready: data.amneziawg_ready,
        vless: data.vless,
        vless_ready: data.vless_ready
      });
    }
  });
}

/** New REALITY keys. Every VLESS device must import its link again; its uuid stays. */
export function useRegenerateVlessParams(orgId: string): UseMutationResult<RegenerateResult, ApiError, void> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<RegenerateResult>(`${base(orgId)}/regenerate`, { method: 'vless-reality' }),
    onSuccess: (data) => {
      queryClient.setQueryData(keyFor(orgId), {
        organization_id: data.organization_id,
        wireguard_wss: data.wireguard_wss,
        amneziawg: data.amneziawg,
        amneziawg_ready: data.amneziawg_ready,
        vless: data.vless,
        vless_ready: data.vless_ready
      });
    }
  });
}
