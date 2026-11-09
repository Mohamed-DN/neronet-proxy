import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import { apiRequest } from '../apiClient';
import type {
  AclDefaultPolicyResponse,
  AclPolicyTest,
  AclPolicyTestFailure,
  AclRule,
  AclRulesResponse,
  AclSimulationResult,
  CompiledPolicy
} from '../types';
import { queryKeys } from './keys';

/**
 * List zero-trust network ACL rules and mesh policy epoch.
 */
export function useAclRules(): UseQueryResult<AclRulesResponse, Error> {
  return useQuery({
    queryKey: queryKeys.aclRules,
    queryFn: async ({ signal }) => {
      const res = await apiRequest<AclRulesResponse>('/acl/rules', { signal });
      return res ?? { rules: [], epoch: 1, policy_is_open: true, count: 0 };
    },
    staleTime: 15_000,
    refetchInterval: 30_000
  });
}

/**
 * Fetch organization default network policy (open vs zero-trust deny).
 */
export function useAclDefaultPolicy(): UseQueryResult<AclDefaultPolicyResponse, Error> {
  return useQuery({
    queryKey: queryKeys.aclDefaultPolicy,
    queryFn: ({ signal }) => apiRequest<AclDefaultPolicyResponse>('/acl/default-policy', { signal }),
    staleTime: 30_000
  });
}

/**
 * Fetch the exact compiled egress/ingress policy a node enforces.
 */
export function useCompiledPolicy(nodeId: string | null): UseQueryResult<CompiledPolicy, Error> {
  return useQuery({
    queryKey: queryKeys.aclCompiled(nodeId || ''),
    queryFn: ({ signal }) => apiRequest<CompiledPolicy>(`/acl/compiled/${encodeURIComponent(nodeId!)}`, { signal }),
    enabled: Boolean(nodeId),
    staleTime: 10_000
  });
}

/**
 * Create a new zero-trust ACL rule.
 */
export function useCreateAclRule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (rule: Partial<AclRule>) => {
      return apiRequest<{ rule: AclRule; epoch: number }>('/acl/rules', {
        method: 'POST',
        body: rule
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.aclRules });
      queryClient.invalidateQueries({ queryKey: queryKeys.statsTopology });
      queryClient.invalidateQueries({ queryKey: queryKeys.acl });
    }
  });
}

/**
 * Update an existing ACL rule.
 */
export function useUpdateAclRule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: Partial<AclRule> }) => {
      return apiRequest<{ rule: AclRule; epoch: number }>(`/acl/rules/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: updates
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.aclRules });
      queryClient.invalidateQueries({ queryKey: queryKeys.statsTopology });
      queryClient.invalidateQueries({ queryKey: queryKeys.acl });
    }
  });
}

/**
 * Delete an ACL rule by ID.
 */
export function useDeleteAclRule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      return apiRequest<{ deleted: string; epoch: number; policy_is_open: boolean }>(
        `/acl/rules/${encodeURIComponent(id)}`,
        {
          method: 'DELETE'
        }
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.aclRules });
      queryClient.invalidateQueries({ queryKey: queryKeys.statsTopology });
      queryClient.invalidateQueries({ queryKey: queryKeys.acl });
    }
  });
}

/**
 * Toggle organization default policy (open vs deny).
 */
export function useUpdateAclDefaultPolicy() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (defaultPolicy: 'open' | 'deny') => {
      return apiRequest<AclDefaultPolicyResponse>('/acl/default-policy', {
        method: 'PUT',
        body: { default_policy: defaultPolicy }
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.aclDefaultPolicy });
      queryClient.invalidateQueries({ queryKey: queryKeys.aclRules });
      queryClient.invalidateQueries({ queryKey: queryKeys.statsTopology });
    }
  });
}

/**
 * Live test packet simulation against active matrix.
 */
export function useSimulateAcl() {
  return useMutation({
    mutationFn: async (packet: { source_ip: string; destination_ip: string; protocol?: string; port?: number }) => {
      return apiRequest<AclSimulationResult>('/acl/simulate', {
        method: 'POST',
        body: packet
      });
    }
  });
}

/**
 * Preview compiled rules for a node with a proposed candidate rule before committing.
 */
export function useCompilePreview() {
  return useMutation({
    mutationFn: async ({ node_id, candidate_rule }: { node_id: string; candidate_rule?: Partial<AclRule> }) => {
      return apiRequest<CompiledPolicy>('/acl/preview', {
        method: 'POST',
        body: { node_id, candidate_rule }
      });
    }
  });
}

/** Policy tests of the caller's organisation (ADR 0028). */
export function usePolicyTests(): UseQueryResult<AclPolicyTest[], Error> {
  return useQuery({
    queryKey: queryKeys.aclTests,
    queryFn: async ({ signal }) =>
      (await apiRequest<{ tests: AclPolicyTest[] }>('/acl/tests', { signal }))?.tests ?? [],
    staleTime: 15_000
  });
}

/** Store an assertion; the server refuses one the current policy already breaks (HTTP 409). */
export function useCreatePolicyTest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (test: Omit<AclPolicyTest, 'id'>) =>
      apiRequest<{ test: AclPolicyTest }>('/acl/tests', { method: 'POST', body: test }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.aclTests })
  });
}

export function useDeletePolicyTest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiRequest<{ deleted: string }>(`/acl/tests/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.aclTests })
  });
}

/** Run the stored assertions against the current policy. */
export function useRunPolicyTests() {
  return useMutation({
    mutationFn: () =>
      apiRequest<{ total: number; failures: AclPolicyTestFailure[] }>('/acl/tests/run', { method: 'POST' })
  });
}

/** The failing assertions carried by a refused save, or null when the error is something else. */
export function policyTestFailuresOf(err: unknown): AclPolicyTestFailure[] | null {
  const details = (err as { details?: { error?: string; failures?: AclPolicyTestFailure[] } } | null)?.details;
  return details?.error === 'policy_tests_failed' && Array.isArray(details.failures) ? details.failures : null;
}
