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
): UseMutationResult<AccessMethodsSettings, ApiError, { wireguard_wss: boolean; amneziawg: boolean }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input) => apiPut<AccessMethodsSettings>(base(orgId), input),
    onSuccess: (data) => {
      queryClient.setQueryData(keyFor(orgId), data);
      void queryClient.invalidateQueries({ queryKey: ['devices', 'profile-methods'] });
    }
  });
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
        amneziawg_ready: data.amneziawg_ready
      });
    }
  });
}
