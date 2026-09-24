import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import { apiRequest } from '../apiClient';
import type {
  AuditCheckpoint,
  AuditEvent,
  AuditLogsResponse,
  AuditVerificationResult,
  SiemDestination
} from '../types';
import { queryKeys } from './keys';

/**
 * List immutable tamper-evident audit events.
 */
export function useAuditEvents(limit = 100): UseQueryResult<AuditEvent[], Error> {
  return useQuery({
    queryKey: queryKeys.auditEvents(limit),
    queryFn: async ({ signal }) => {
      const res = await apiRequest<AuditLogsResponse | { audit_logs?: AuditEvent[]; events?: AuditEvent[] }>(
        `/audit/events?limit=${limit}`,
        { signal }
      );
      if (Array.isArray(res)) return res;
      return (res as any)?.audit_logs || (res as any)?.events || [];
    },
    staleTime: 15_000,
    refetchInterval: 30_000
  });
}

/**
 * Perform live cryptographic hash chain verification across all audit records.
 */
export function useVerifyAuditChain(): UseQueryResult<AuditVerificationResult, Error> {
  return useQuery({
    queryKey: queryKeys.auditVerify,
    queryFn: async ({ signal }) => {
      const res = await apiRequest<{ verification: AuditVerificationResult }>('/audit/verify', { signal });
      return res?.verification ?? { valid: false };
    },
    staleTime: 30_000
  });
}

/**
 * List signed cryptographic audit checkpoints.
 */
export function useAuditCheckpoints(): UseQueryResult<{ checkpoints: AuditCheckpoint[]; public_key?: string }, Error> {
  return useQuery({
    queryKey: queryKeys.auditCheckpoints,
    queryFn: async ({ signal }) => {
      const res = await apiRequest<{ checkpoints: AuditCheckpoint[]; public_key?: string }>('/audit/checkpoints', {
        signal
      });
      return { checkpoints: res?.checkpoints ?? [], public_key: res?.public_key };
    },
    staleTime: 30_000
  });
}

/**
 * Generate a new signed cryptographic checkpoint for the current chain state.
 */
export function useCreateAuditCheckpoint() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      return apiRequest<{ checkpoint: AuditCheckpoint }>('/audit/checkpoints', {
        method: 'POST'
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.auditCheckpoints });
      queryClient.invalidateQueries({ queryKey: queryKeys.auditVerify });
    }
  });
}

/**
 * List registered SIEM forwarders (Syslog RFC 5424, CEF, LEEF, JSON).
 */
export function useSiemDestinations(): UseQueryResult<SiemDestination[], Error> {
  return useQuery({
    queryKey: queryKeys.auditSiem,
    queryFn: async ({ signal }) => {
      const res = await apiRequest<{ destinations: SiemDestination[] }>('/audit/siem', { signal });
      return res?.destinations ?? [];
    },
    staleTime: 30_000
  });
}

/**
 * Register a new SIEM forwarder destination.
 */
export function useCreateSiemDestination() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (dest: Partial<SiemDestination>) => {
      return apiRequest<{ destination: SiemDestination }>('/audit/siem', {
        method: 'POST',
        body: dest
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.auditSiem });
    }
  });
}

/**
 * Remove a SIEM forwarder destination.
 */
export function useDeleteSiemDestination() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      return apiRequest<{ success: boolean; deleted: string }>(`/audit/siem/${encodeURIComponent(id)}`, {
        method: 'DELETE'
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.auditSiem });
    }
  });
}
