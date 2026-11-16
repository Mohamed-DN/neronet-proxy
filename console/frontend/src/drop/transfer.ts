import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import { ApiError, apiGet, apiPost } from '../services/apiClient';
import { Decryptor, ciphertextLength, encryptFile, newFileKey, type OpenedManifest } from './dropCrypto';
import { buildDropLink } from './link';

/*
 * NeroDrop in the browser (ADR 0033). The console API (/api/drop) answers metadata and
 * tickets; the ciphertext goes to /drop-blob/<id>, which the console's reverse proxy
 * forwards to the organisation's gateway. The key and the file name stay here: no
 * request below carries either.
 */

export interface DropConfig {
  enabled: boolean;
  available: boolean;
  may_send: boolean;
  can_manage: boolean;
  max_bytes: number;
  lifetime_hours: number;
}

export interface DropPeer {
  id: string;
  username: string;
}

export interface DropItem {
  id: string;
  short_code: string;
  peer: DropPeer;
  ciphertext_bytes: number;
  one_time: boolean;
  status: 'pending' | 'sent' | 'received';
  created_at: string;
  expires_at: string;
  received_at: string | null;
}

interface Ticket {
  url: string;
  ticket: string;
  expires_at: string;
}

interface CreatedTransfer {
  id: string;
  short_code: string;
  expires_at: string;
  upload: Ticket;
}

const KEYS = {
  config: ['drop', 'config'] as const,
  recipients: ['drop', 'recipients'] as const,
  inbox: ['drop', 'inbox'] as const,
  outbox: ['drop', 'outbox'] as const
};

export function useDropConfig(): UseQueryResult<DropConfig, ApiError> {
  return useQuery({ queryKey: KEYS.config, queryFn: ({ signal }) => apiGet<DropConfig>('/drop/config', { signal }) });
}

export function useDropRecipients(enabled: boolean): UseQueryResult<DropPeer[], ApiError> {
  return useQuery({
    queryKey: KEYS.recipients,
    enabled,
    queryFn: async ({ signal }) => (await apiGet<{ recipients: DropPeer[] }>('/drop/recipients', { signal })).recipients
  });
}

export function useDropInbox(): UseQueryResult<DropItem[], ApiError> {
  return useQuery({
    queryKey: KEYS.inbox,
    queryFn: async ({ signal }) => (await apiGet<{ transfers: DropItem[] }>('/drop/inbox', { signal })).transfers,
    refetchInterval: 30_000
  });
}

/** The mailbox answered something other than success. */
export class DropTransferError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`The file store answered ${status}.`);
    this.name = 'DropTransferError';
    this.status = status;
  }
}

export type SendStage = 'encrypting' | 'uploading';

export interface SendInput {
  file: File;
  recipientId: string;
  oneTime: boolean;
  onStage?: (stage: SendStage, done: number, total: number) => void;
}

export interface SendResult {
  id: string;
  shortCode: string;
  link: string;
  expiresAt: string;
}

/** Blob.arrayBuffer where it exists (every current browser); FileReader elsewhere. */
export function readBlob(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
    reader.readAsArrayBuffer(blob);
  });
}

function fileSource(file: File) {
  return {
    size: file.size,
    read: async (start: number, end: number) => new Uint8Array(await readBlob(file.slice(start, end)))
  };
}

/** Encrypts the file here, stores the ciphertext on the gateway, and answers the link. */
export async function sendFile({ file, recipientId, oneTime, onStage }: SendInput): Promise<SendResult> {
  const key = newFileKey();
  const bytes = ciphertextLength(file.size);
  const created = await apiPost<CreatedTransfer>('/drop/transfers', {
    recipient_id: recipientId,
    ciphertext_bytes: bytes,
    one_time: oneTime
  });
  onStage?.('encrypting', 0, file.size);
  const parts = await encryptFile(fileSource(file), { name: file.name, type: file.type }, created.id, key, {
    onProgress: (done, total) => onStage?.('encrypting', done, total)
  });
  onStage?.('uploading', 0, bytes);
  const body = new Blob(parts as BlobPart[], { type: 'application/octet-stream' });
  const res = await fetch(created.upload.url, {
    method: 'PUT',
    headers: { Authorization: `NeroDrop ${created.upload.ticket}`, 'Content-Type': 'application/octet-stream' },
    body,
    credentials: 'omit'
  });
  if (!res.ok) throw new DropTransferError(res.status);
  onStage?.('uploading', bytes, bytes);
  await apiPost(`/drop/transfers/${created.id}/sent`, {});
  return {
    id: created.id,
    shortCode: created.short_code,
    link: buildDropLink(window.location.origin, created.id, key),
    expiresAt: created.expires_at
  };
}

export interface ReceiveResult {
  manifest: OpenedManifest;
  blob: Blob;
}

/** Fetches the ciphertext with a download ticket and decrypts it here. */
export async function receiveFile(
  id: string,
  key: Uint8Array,
  onProgress?: (done: number, total: number) => void
): Promise<ReceiveResult> {
  const ticket = await apiPost<Ticket & { ciphertext_bytes: number }>(`/drop/transfers/${id}/download-ticket`, {});
  const res = await fetch(ticket.url, {
    headers: { Authorization: `NeroDrop ${ticket.ticket}` },
    credentials: 'omit',
    cache: 'no-store'
  });
  if (!res.ok) throw new DropTransferError(res.status);
  const decryptor = new Decryptor(id, key, { onProgress });
  const reader = res.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) await decryptor.push(value);
    }
  } else {
    await decryptor.push(new Uint8Array(await res.arrayBuffer()));
  }
  const { manifest, parts } = await decryptor.finish();
  await apiPost(`/drop/transfers/${id}/received`, {});
  return { manifest, blob: new Blob(parts as BlobPart[], { type: manifest.type || 'application/octet-stream' }) };
}

/** Refreshes the inbox after a receive, and both lists after a send. */
export function useDropRefresh() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: KEYS.inbox });
    void client.invalidateQueries({ queryKey: KEYS.outbox });
  };
}

export function useSendFile() {
  const refresh = useDropRefresh();
  return useMutation({ mutationFn: sendFile, onSuccess: refresh });
}
