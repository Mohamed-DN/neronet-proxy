import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import { apiRequest } from '../apiClient';
import type { InvitableRole } from '../roles';

export type InvitationStatus = 'pending' | 'used' | 'expired' | 'revoked';

/** An invitation as the list shows it. The server never sends the token or the code here. */
export interface Invitation {
  id: string;
  organization_id: string;
  role: InvitableRole;
  display_name_hint: string | null;
  created_by: string | null;
  created_by_username?: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  used_by: string | null;
  used_by_username?: string | null;
  revoked_at: string | null;
  status: InvitationStatus;
}

export interface CreateInvitationPayload {
  role: InvitableRole;
  expires_in_days: number;
  display_name_hint?: string;
}

/** The answer to a creation: the only time the secret is ever sent. */
export interface CreatedInvitation {
  invitation: Invitation;
  token: string;
  code: string;
}

export const invitationKeys = {
  list: (orgId: string) => ['organizations', orgId, 'invitations'] as const
};

export function useInvitations(orgId: string | null | undefined): UseQueryResult<Invitation[], Error> {
  return useQuery({
    queryKey: invitationKeys.list(orgId ?? ''),
    enabled: Boolean(orgId),
    queryFn: async ({ signal }) => {
      const res = await apiRequest<{ invitations?: Invitation[] }>(
        `/organizations/${encodeURIComponent(orgId ?? '')}/invitations`,
        { signal }
      );
      return Array.isArray(res?.invitations) ? res.invitations : [];
    }
  });
}

export function useCreateInvitation(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateInvitationPayload) =>
      apiRequest<CreatedInvitation>(`/organizations/${encodeURIComponent(orgId)}/invitations`, {
        method: 'POST',
        body: payload
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: invitationKeys.list(orgId) })
  });
}

export function useRevokeInvitation(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: string) =>
      apiRequest<{ invitation: Invitation }>(
        `/organizations/${encodeURIComponent(orgId)}/invitations/${encodeURIComponent(invitationId)}`,
        { method: 'DELETE' }
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: invitationKeys.list(orgId) })
  });
}

/** Public: accepting needs no session. Exactly one of token or code. */
export function acceptInvitation(body: { token?: string; code?: string; username: string; password: string }) {
  return apiRequest<{ ok: true; username: string }>('/invitations/accept', { method: 'POST', body });
}
