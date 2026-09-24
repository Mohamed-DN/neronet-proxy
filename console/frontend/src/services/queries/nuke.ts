import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import { apiRequest } from '../apiClient';
import type { DualAuthRequest, LegalHold, NukeGovernanceOverview } from '../types';
import { queryKeys } from './keys';

/**
 * High-level cryptographic shredding governance status overview.
 */
export function useNukeOverview(): UseQueryResult<NukeGovernanceOverview, Error> {
  return useQuery({
    queryKey: queryKeys.nukeStatus,
    queryFn: async ({ signal }) => {
      const res = await apiRequest<NukeGovernanceOverview | { status?: NukeGovernanceOverview }>('/nuke/status', {
        signal
      });
      if ((res as any)?.status) return (res as any).status;
      return res as NukeGovernanceOverview;
    },
    staleTime: 10_000,
    refetchInterval: 30_000
  });
}

/**
 * List all active and historical legal holds on organizations.
 */
export function useLegalHolds(): UseQueryResult<LegalHold[], Error> {
  return useQuery({
    queryKey: queryKeys.nukeLegalHolds,
    queryFn: async ({ signal }) => {
      const res = await apiRequest<{ legal_holds?: LegalHold[]; holds?: LegalHold[] }>('/nuke/legal-hold', { signal });
      return res?.legal_holds || res?.holds || [];
    },
    staleTime: 15_000
  });
}

/**
 * Impose a new legal hold to block data destruction.
 */
export function useImposeLegalHold() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ organization_id, reason }: { organization_id: string; reason: string }) => {
      return apiRequest<{ hold: LegalHold }>('/nuke/legal-hold', {
        method: 'POST',
        body: { organization_id, reason }
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.nukeLegalHolds });
      queryClient.invalidateQueries({ queryKey: queryKeys.nukeStatus });
    }
  });
}

/**
 * Release an active legal hold.
 */
export function useReleaseLegalHold() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (holdId: string) => {
      return apiRequest<{ success: boolean; released: LegalHold }>(`/nuke/legal-hold/${encodeURIComponent(holdId)}`, {
        method: 'DELETE'
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.nukeLegalHolds });
      queryClient.invalidateQueries({ queryKey: queryKeys.nukeStatus });
    }
  });
}

/**
 * List all dual-authorization destruction requests (pending, executed, rejected).
 */
export function useDualAuthRequests(): UseQueryResult<DualAuthRequest[], Error> {
  return useQuery({
    queryKey: queryKeys.nukeDualAuth,
    queryFn: async ({ signal }) => {
      const res = await apiRequest<{ authorizations?: DualAuthRequest[]; requests?: DualAuthRequest[] }>(
        '/nuke/dual-auth',
        { signal }
      );
      return res?.authorizations || res?.requests || [];
    },
    staleTime: 10_000,
    refetchInterval: 20_000
  });
}

/**
 * Propose a dual-authorization destruction operation (Initiator / 1st approver).
 */
export function useRequestDualAuthDestruction() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: { target_type: 'organization' | 'global'; target_id: string; comment?: string }) => {
      return apiRequest<{ authorization: DualAuthRequest }>('/nuke/dual-auth/request', {
        method: 'POST',
        body: payload
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.nukeDualAuth });
      queryClient.invalidateQueries({ queryKey: queryKeys.nukeStatus });
    }
  });
}

/**
 * Second administrator approves and permanently executes crypto-shredding (2nd approver).
 */
export function useApproveDualAuthDestruction() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, comment }: { id: string; comment?: string }) => {
      return apiRequest<{ success: boolean; authorization_id: string; shredResult: unknown }>(
        `/nuke/dual-auth/approve/${encodeURIComponent(id)}`,
        {
          method: 'POST',
          body: { comment }
        }
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.nukeDualAuth });
      queryClient.invalidateQueries({ queryKey: queryKeys.nukeStatus });
      queryClient.invalidateQueries({ queryKey: queryKeys.nodes });
    }
  });
}

/**
 * Reject or cancel a pending dual-authorization destruction request.
 */
export function useRejectDualAuthDestruction() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, comment }: { id: string; comment?: string }) => {
      return apiRequest<{ success: boolean; authorization: DualAuthRequest }>(
        `/nuke/dual-auth/reject/${encodeURIComponent(id)}`,
        {
          method: 'POST',
          body: { comment }
        }
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.nukeDualAuth });
      queryClient.invalidateQueries({ queryKey: queryKeys.nukeStatus });
    }
  });
}

/**
 * Retrieve Network Owner Dead Man's Switch status.
 */
export function useOwnerDmsStatus(): UseQueryResult<any, Error> {
  return useQuery({
    queryKey: queryKeys.nukeOwnerDms,
    queryFn: async ({ signal }) => {
      return apiRequest<any>('/nuke/owner-dms/status', { signal });
    },
    staleTime: 30_000
  });
}

/**
 * Setup or reconfigure Network Owner Dead Man's Switch.
 */
export function useSetupOwnerDms() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: {
      passphrase: string;
      heartbeat_interval_seconds: number;
      canary_webhook_url?: string;
    }) => {
      return apiRequest<any>('/nuke/owner-dms/setup', {
        method: 'POST',
        body: payload
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.nukeOwnerDms });
      queryClient.invalidateQueries({ queryKey: queryKeys.nukeStatus });
    }
  });
}

/**
 * Confirm owner heartbeat and reset timer.
 */
export function useHeartbeatOwnerDms() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (passphrase: string) => {
      return apiRequest<any>('/nuke/owner-dms/heartbeat', {
        method: 'POST',
        body: { passphrase }
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.nukeOwnerDms });
    }
  });
}

/**
 * Super-Admin emergency manual global purge execution.
 */
export function useTriggerOwnerWipe() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: { confirmation_phrase: string; password: string }) => {
      return apiRequest<any>('/nuke/owner-dms/trigger', {
        method: 'POST',
        body: payload
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries();
    }
  });
}
