import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import { apiRequest } from '../apiClient';

export type AppSessionStatus = 'active' | 'revoked' | 'expired';

/** An app a person signed in, as the list shows it. The server never sends a token here. */
export interface AppSession {
  id: string;
  user_id: string;
  username?: string;
  organization_id: string;
  platform: 'windows' | 'macos' | 'linux' | 'android' | 'ios';
  device_name: string;
  node_id: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  status: AppSessionStatus;
}

/** What is asking to sign in, shown before the person decides. */
export interface AppSignInRequest {
  /** The code as the console reads it, to be compared with the app's screen. */
  user_code?: string;
  /** What the app asks to be allowed to do: scope names the page puts into words. */
  scopes?: string[];
  platform: AppSession['platform'];
  device_name: string;
  request_ip: string | null;
  requested_at: string;
  expires_at: string;
  mfa_required: boolean;
}

export const appSessionKeys = {
  own: ['app-auth', 'sessions', 'own'] as const,
  organization: ['app-auth', 'sessions', 'organization'] as const
};

export function useAppSessions(scope: 'own' | 'organization' = 'own'): UseQueryResult<AppSession[], Error> {
  return useQuery({
    queryKey: scope === 'own' ? appSessionKeys.own : appSessionKeys.organization,
    queryFn: async ({ signal }) => {
      const res = await apiRequest<{ sessions?: AppSession[] }>(
        `/app-auth/sessions${scope === 'organization' ? '?scope=organization' : ''}`,
        { signal }
      );
      return Array.isArray(res?.sessions) ? res.sessions : [];
    }
  });
}

export function useRevokeAppSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiRequest<{ revoked: true }>(`/app-auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['app-auth', 'sessions'] })
  });
}

export function lookupAppCode(userCode: string) {
  return apiRequest<AppSignInRequest>('/app-auth/device/lookup', { method: 'POST', body: { user_code: userCode } });
}

export function approveAppCode(userCode: string, proof?: { totp_code?: string; recovery_code?: string }) {
  return apiRequest<{ approved: true }>('/app-auth/device/approve', {
    method: 'POST',
    body: { user_code: userCode, ...proof }
  });
}

export function denyAppCode(userCode: string) {
  return apiRequest<{ denied: true }>('/app-auth/device/deny', { method: 'POST', body: { user_code: userCode } });
}
