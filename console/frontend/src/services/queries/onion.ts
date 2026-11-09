import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

import { apiPost, type ApiError } from '../apiClient';

const nodesKey = ['nodes'] as const;

/**
 * Turns three-stop routing on or off for one device.
 *
 * The server stores the preference and answers 403 when the feature is switched
 * off for the organisation. It does not route traffic: the node daemon does not
 * read the setting yet, and the page says so.
 */
export function useToggleOnion(): UseMutationResult<unknown, ApiError, { nodeId: string; enabled: boolean }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId, enabled }: { nodeId: string; enabled: boolean }) =>
      apiPost(`/nodes/${encodeURIComponent(nodeId)}/action`, {
        action: 'toggle_onion',
        params: { enabled }
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: nodesKey });
    }
  });
}
