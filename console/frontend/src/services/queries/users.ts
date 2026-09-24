import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import { apiRequest } from '../apiClient';
import type { CreateOrgPayload, CreateUserPayload, Organization, QrOnboardingData, UserAccount } from '../types';
import { queryKeys } from './keys';

/**
 * Fetch all registered users in the organization or global fleet.
 */
export function useUsers(): UseQueryResult<UserAccount[], Error> {
  return useQuery({
    queryKey: queryKeys.users,
    queryFn: async ({ signal }) => {
      const res = await apiRequest<{ users?: UserAccount[] } | UserAccount[]>('/users', { signal });
      if (Array.isArray(res)) return res;
      return res?.users || [];
    },
    staleTime: 10_000
  });
}

/**
 * Fetch a single user by ID.
 */
export function useUser(id: string): UseQueryResult<UserAccount, Error> {
  return useQuery({
    queryKey: queryKeys.user(id),
    queryFn: async ({ signal }) => {
      const res = await apiRequest<{ user?: UserAccount } | UserAccount>(`/users/${encodeURIComponent(id)}`, {
        signal
      });
      if ((res as any)?.user) return (res as any).user;
      return res as UserAccount;
    },
    enabled: Boolean(id)
  });
}

/**
 * Create a new user tenant account.
 */
export function useCreateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: CreateUserPayload) => {
      const res = await apiRequest<{ user: UserAccount }>('/users', {
        method: 'POST',
        body: payload
      });
      return res.user;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.users });
      queryClient.invalidateQueries({ queryKey: queryKeys.statsOverview });
    }
  });
}

/**
 * Delete a user and revoke all credentials.
 */
export function useDeleteUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => {
      await apiRequest(`/users/${encodeURIComponent(userId)}`, {
        method: 'DELETE'
      });
      return userId;
    },
    onSuccess: (userId) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.users });
      queryClient.removeQueries({ queryKey: queryKeys.user(userId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.statsOverview });
    }
  });
}

/**
 * Revoke all active sessions and refresh tokens for a user.
 */
export function useRevokeUserSessions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => {
      const res = await apiRequest<{ ok: boolean; revoked_count?: number }>(
        `/users/${encodeURIComponent(userId)}/revoke-sessions`,
        { method: 'POST' }
      );
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.users });
      queryClient.invalidateQueries({ queryKey: queryKeys.auditEvents() });
    }
  });
}

/**
 * Generate a WireGuard client QR onboarding profile for a user.
 */
export function useGenerateQrOnboarding() {
  return useMutation({
    mutationFn: async (userId: string) => {
      const res = await apiRequest<QrOnboardingData>(`/users/${encodeURIComponent(userId)}/onboard-qr`, {
        method: 'GET'
      });
      return res;
    }
  });
}

/**
 * Update split-tunneling app bypass list for a user.
 */
export function useUpdateSplitTunneling() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ userId, bypassApps }: { userId: string; bypassApps: string[] }) => {
      const res = await apiRequest<{ user: UserAccount }>(`/users/${encodeURIComponent(userId)}/split-tunneling`, {
        method: 'PUT',
        body: { bypass_apps: bypassApps }
      });
      return res.user;
    },
    onSuccess: (user) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.users });
      queryClient.setQueryData(queryKeys.user(user.id), user);
    }
  });
}

/**
 * Fetch all organizations.
 */
export function useOrganizations(): UseQueryResult<Organization[], Error> {
  return useQuery({
    queryKey: queryKeys.organizations,
    queryFn: async ({ signal }) => {
      const res = await apiRequest<{ organizations?: Organization[] } | Organization[]>('/organizations', { signal });
      if (Array.isArray(res)) return res;
      return res?.organizations || [];
    },
    staleTime: 30_000
  });
}

/**
 * Create a new multi-tenant organization.
 */
export function useCreateOrganization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: CreateOrgPayload) => {
      const res = await apiRequest<{ organization: Organization }>('/organizations', {
        method: 'POST',
        body: payload
      });
      return res.organization;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations });
    }
  });
}
