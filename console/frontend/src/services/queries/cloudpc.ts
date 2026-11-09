import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult
} from '@tanstack/react-query';

import { apiDelete, apiPost, apiRequest, type ApiError } from '../apiClient';

/*
 * Hooks for the virtual computers page. Imported by path (not through
 * queries/index.ts), and their keys stay local per the plan's file rules.
 * The endpoints are the ones services/api.js used for the legacy page.
 */

const cloudPcKey = ['cloud-pc'] as const;
const domainsKey = ['cloud-pc', 'custom-domains'] as const;

/** A virtual computer as the control plane describes it. Any field may be absent. */
export interface CloudPc {
  id: string;
  name: string;
  status?: string | null;
  os_type?: string | null;
  resolution?: string | null;
  fps?: number | null;
  codec?: string | null;
  cpu_cores?: number | null;
  memory_mb?: number | null;
  storage_gb?: number | null;
  gpu_acceleration?: boolean | null;
  webrtc_signaling_url?: string | null;
}

export interface CustomDomain {
  domain: string;
  cname_target?: string | null;
  cpc_id: string;
  cpc_name?: string | null;
  dns_status?: string | null;
  ssl_status?: string | null;
  sso_enforced?: boolean;
  otp_gateway_required?: boolean;
}

export interface AccessLink {
  viewer_url: string;
  signaling_url?: string | null;
  stream_token?: string | null;
  codec?: string | null;
}

export interface VerifyResult {
  verified?: boolean;
  reason?: string | null;
}

export interface AddDomainInput {
  domain: string;
  cpc_id: string;
  cpc_name: string;
  sso_enforced: boolean;
  otp_gateway_required: boolean;
}

export function useCloudPcs(): UseQueryResult<CloudPc[], Error> {
  return useQuery({
    queryKey: cloudPcKey,
    queryFn: async ({ signal }) => {
      const body = await apiRequest<{ instances?: CloudPc[] }>('/cloud-pc', { signal });
      return Array.isArray(body?.instances) ? body.instances : [];
    }
  });
}

export function useCustomDomains(): UseQueryResult<CustomDomain[], Error> {
  return useQuery({
    queryKey: domainsKey,
    queryFn: async ({ signal }) => {
      const body = await apiRequest<{ custom_domains?: CustomDomain[] }>('/cloud-pc/custom-domains', { signal });
      return Array.isArray(body?.custom_domains) ? body.custom_domains : [];
    }
  });
}

/** Asks the control plane for an access link to one virtual computer. */
export function useCreateAccessLink(): UseMutationResult<AccessLink, ApiError, string> {
  return useMutation({
    mutationFn: (id: string) => apiPost<AccessLink>(`/cloud-pc/${encodeURIComponent(id)}/project`)
  });
}

export function useAddCustomDomain(): UseMutationResult<CustomDomain, ApiError, AddDomainInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: AddDomainInput) => {
      const body = await apiPost<{ domain?: CustomDomain }>('/cloud-pc/custom-domains', input);
      if (!body?.domain) throw new Error('The control plane did not return the domain');
      return body.domain;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: domainsKey });
    }
  });
}

export function useDeleteCustomDomain(): UseMutationResult<unknown, ApiError, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (domain: string) => apiDelete(`/cloud-pc/custom-domains/${encodeURIComponent(domain)}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: domainsKey });
    }
  });
}

export function useVerifyCustomDomain(): UseMutationResult<VerifyResult, ApiError, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (domain: string) =>
      apiPost<VerifyResult>(`/cloud-pc/custom-domains/${encodeURIComponent(domain)}/verify`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: domainsKey });
    }
  });
}
