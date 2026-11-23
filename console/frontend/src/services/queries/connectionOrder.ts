import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult
} from '@tanstack/react-query';

import { apiGet, apiPost, apiPut, type ApiError } from '../apiClient';

/*
 * Connection order by scope (ADR 0037). The server resolves the effective order; the console
 * only edits one scope at a time and shows where the effective order came from.
 */

export type AccessMethodId = 'wireguard' | 'wireguard-wss' | 'amneziawg' | 'vless-reality';
export const ACCESS_METHOD_IDS: readonly AccessMethodId[] = [
  'wireguard',
  'wireguard-wss',
  'amneziawg',
  'vless-reality'
];

export type ConnectionScope = 'default' | 'organization' | 'line' | 'device' | 'person';

export interface ConnectionOrigin {
  scope: ConnectionScope;
  id?: string;
  name?: string;
}

export interface EffectiveOrder {
  order: AccessMethodId[];
  forced: boolean;
  origin: ConnectionOrigin;
  /** False when no method of the order is one the device's gateway runs. */
  usable: boolean;
  person_blocked: 'not_enabled' | 'locked' | null;
}

export interface OwnOrder {
  order: AccessMethodId[] | null;
  forced: boolean;
}

export interface OrganizationConnectionOrder {
  organization_id: string;
  allowed: AccessMethodId[];
  own: OwnOrder;
  members_may_choose: boolean;
  default_order: AccessMethodId[];
  effective: EffectiveOrder;
}

export interface DeviceConnectionOrder {
  device_id: string;
  name: string;
  /** The method the device's profile was made for. */
  access_method: AccessMethodId;
  line: { id: string; name: string; locked: boolean } | null;
  allowed: AccessMethodId[];
  /** Methods the serving gateway runs now; null when it has no gateway. */
  available: AccessMethodId[] | null;
  own: OwnOrder & { locked: boolean };
  members_may_choose: boolean;
  inherited: EffectiveOrder;
  effective: EffectiveOrder;
  can_edit: boolean;
  can_lock: boolean;
}

export interface DeviceRef {
  id: string;
  name: string | null;
}

/** Who a change would affect (the server's simulation, nothing written). */
export interface ChangePlan {
  /** Devices left with no method their gateway runs: the server refuses the change. */
  strands: DeviceRef[];
  strands_total: number;
  /** Devices whose profile method left their order: their person must import a new profile. */
  reimport: Array<DeviceRef & { access_method: AccessMethodId }>;
  reimport_total: number;
}

export interface OrderChange {
  order: AccessMethodId[] | null;
  forced: boolean;
}

const KEYS = {
  organization: ['connection-order', 'organization'] as const,
  device: (id: string) => ['connection-order', 'device', id] as const
};

const base = '/connection-order';

export function useOrganizationConnectionOrder(enabled = true): UseQueryResult<OrganizationConnectionOrder, ApiError> {
  return useQuery({
    queryKey: KEYS.organization,
    enabled,
    queryFn: ({ signal }) => apiGet<OrganizationConnectionOrder>(`${base}/organization`, { signal })
  });
}

export function useSetOrganizationConnectionOrder(): UseMutationResult<
  OrganizationConnectionOrder & { plan: ChangePlan },
  ApiError,
  Partial<OrderChange> & { members_may_choose?: boolean }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input) => apiPut<OrganizationConnectionOrder & { plan: ChangePlan }>(`${base}/organization`, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['connection-order'] });
      void queryClient.invalidateQueries({ queryKey: ['devices', 'profile-methods'] });
    }
  });
}

export function useDeviceConnectionOrder(
  deviceId: string,
  enabled = true
): UseQueryResult<DeviceConnectionOrder, ApiError> {
  return useQuery({
    queryKey: KEYS.device(deviceId),
    enabled,
    queryFn: ({ signal }) =>
      apiGet<DeviceConnectionOrder>(`${base}/devices/${encodeURIComponent(deviceId)}`, { signal })
  });
}

export function useSetDeviceConnectionOrder(
  deviceId: string
): UseMutationResult<
  DeviceConnectionOrder & { plan: ChangePlan },
  ApiError,
  Partial<OrderChange> & { locked?: boolean }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input) =>
      apiPut<DeviceConnectionOrder & { plan: ChangePlan }>(`${base}/devices/${encodeURIComponent(deviceId)}`, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['connection-order'] });
    }
  });
}

export interface PreviewRequest {
  scope: 'organization' | 'line' | 'device';
  id?: string;
  settings: OrderChange;
}

export function usePreviewConnectionOrder(): UseMutationResult<ChangePlan, ApiError, PreviewRequest> {
  return useMutation({ mutationFn: (input) => apiPost<ChangePlan>(`${base}/preview`, input) });
}
