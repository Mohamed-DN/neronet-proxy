import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult
} from '@tanstack/react-query';

import { apiDelete, apiGet, apiPost, type ApiError } from '../apiClient';

const peeringKey = ['peering'] as const;

export type PeeringScope = 'ALL' | 'SPECIFIC_DEVICES' | 'SPECIFIC_SUBNETS';

/** One link with another network, as `GET /peering` lists it. */
export interface PeeringAgreement {
  id: string;
  peer_name: string;
  initiator_endpoint: string;
  scope_mode: PeeringScope;
  shared_subnets: string[];
  shared_device_ids?: string[];
  /** Devices received from the other network. Accepting a code does not import any, so this is usually empty. */
  imported_nodes: unknown[];
  status: 'pending' | 'active' | 'revoked' | 'expired';
  expires_at: string;
}

/** The code the operator pasted is not a code this console can read. */
export class InvalidPeeringCode extends Error {
  constructor() {
    super('The peering code is not valid');
    this.name = 'InvalidPeeringCode';
  }
}

/** Base64 of the UTF-8 JSON of a signed token. The form a code travels in between administrators. */
export function encodeCode(token: object): string {
  const bytes = new TextEncoder().encode(JSON.stringify(token));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Reads a pasted code. Spaces and line breaks are ignored, because a code copied
 * from a message or a PDF arrives wrapped. Anything that is not a base64 JSON
 * object throws InvalidPeeringCode; nothing is sent to the server for it.
 */
export function decodeCode(code: string): object {
  const compact = code.replace(/\s+/g, '');
  try {
    const binary = atob(compact);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // Fall through to the one error the caller handles.
  }
  throw new InvalidPeeringCode();
}

/** The links with other networks, from `GET /peering`. */
export function usePeeringAgreements(): UseQueryResult<PeeringAgreement[], Error> {
  return useQuery({
    queryKey: peeringKey,
    queryFn: async ({ signal }) => {
      const body = await apiGet<{ peering_agreements?: PeeringAgreement[] }>('/peering', { signal });
      if (!Array.isArray(body?.peering_agreements)) {
        throw new Error('The control plane returned no list of links');
      }
      return body.peering_agreements;
    },
    staleTime: 15_000
  });
}

export interface CreatePeeringCodeInput {
  initiator_endpoint: string;
  scope_mode: 'ALL' | 'SPECIFIC_SUBNETS';
  /** Empty for ALL. The server signs its own default range when none is sent. */
  shared_subnets: string[];
  expires_at: string;
}

/** Asks the server to sign a code for another network, and returns the code to send. */
export function useCreatePeeringCode(): UseMutationResult<string, ApiError, CreatePeeringCodeInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreatePeeringCodeInput) => {
      const body = await apiPost<{ peering_agreement?: object }>('/peering/request', input);
      if (!body?.peering_agreement) throw new Error('The control plane did not return a code');
      return encodeCode(body.peering_agreement);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: peeringKey });
    }
  });
}

export interface AcceptPeeringCodeInput {
  code: string;
  /** Sent on the second attempt, after the operator has matched the fingerprint with the other administrator. */
  expectedFingerprint?: string;
}

/**
 * Accepts a code from another network. The server checks the signature and
 * answers 428 with the key's fingerprint until the operator confirms it.
 */
export function useAcceptPeeringCode(): UseMutationResult<
  PeeringAgreement,
  ApiError | InvalidPeeringCode,
  AcceptPeeringCodeInput
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ code, expectedFingerprint }: AcceptPeeringCodeInput) => {
      const token = decodeCode(code);
      const body = await apiPost<{ peering_agreement?: PeeringAgreement }>('/peering/accept', {
        peering_token: token,
        expected_fingerprint: expectedFingerprint
      });
      if (!body?.peering_agreement) throw new Error('The control plane did not return the link');
      return body.peering_agreement;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: peeringKey });
    }
  });
}

/** Revokes a link. The other network loses access at once. */
export function useRevokePeering(): UseMutationResult<unknown, ApiError, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiDelete(`/peering/${encodeURIComponent(id)}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: peeringKey });
    }
  });
}
