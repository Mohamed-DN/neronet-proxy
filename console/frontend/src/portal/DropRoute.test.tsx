import { webcrypto } from 'node:crypto';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { encryptFile, newFileKey } from '../drop/dropCrypto';
import { buildDropLink, toBase64Url } from '../drop/link';
import { readBlob } from '../drop/transfer';
import { expectNoAxeViolations, renderUI } from '../test/harness';
import DropRoute from './DropRoute';

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(async (_value: string, _options: unknown) => 'data:image/png;base64,AAA') }
}));

const ID = '7f3a09c2aa55bb66cc77dd88ee99ff00';
const CONFIG = {
  enabled: true,
  available: true,
  may_send: true,
  can_manage: false,
  max_bytes: 268435456,
  lifetime_hours: 24
};
const RECIPIENTS = { recipients: [{ id: 'usr-bruno', username: 'bruno' }] };
const INBOX_ITEM = {
  id: ID,
  short_code: '7F3A-09C2',
  peer: { id: 'usr-anna', username: 'anna' },
  ciphertext_bytes: 1100,
  one_time: true,
  status: 'sent',
  created_at: '2026-11-16T08:00:00Z',
  expires_at: '2026-11-17T08:00:00Z',
  received_at: null
};
const MARKER = 'NERODROP-PLAINTEXT-MARKER';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  url: string;
  method: string;
  init: RequestInit | undefined;
}

type Handler = (call: Call) => Response | undefined | Promise<Response | undefined>;

function stubFetch(extra: Handler = () => undefined, overrides: { config?: unknown; inbox?: unknown[] } = {}) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), method: (init?.method ?? 'GET').toUpperCase(), init };
    calls.push(call);
    const answered = await extra(call);
    if (answered) return answered;
    if (call.url.endsWith('/api/drop/config')) return json(200, overrides.config ?? CONFIG);
    if (call.url.endsWith('/api/drop/recipients')) return json(200, RECIPIENTS);
    if (call.url.endsWith('/api/drop/inbox')) return json(200, { transfers: overrides.inbox ?? [] });
    return json(404, { error: 'not stubbed', code: 'not_stubbed' });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function renderDrop(path = '/drop') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return renderUI(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/drop" element={<DropRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function blobBytes(body: unknown): Promise<Uint8Array> {
  return new Uint8Array(await readBlob(body as Blob));
}

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:drop'), revokeObjectURL: vi.fn() }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('DropRoute: send', () => {
  it('encrypts in the browser, uploads only ciphertext with the ticket, and shows the link, the code and a QR', async () => {
    let uploaded: Uint8Array | null = null;
    let uploadAuth = '';
    const calls = stubFetch(async (call) => {
      if (call.url.endsWith('/api/drop/transfers') && call.method === 'POST') {
        return json(201, {
          id: ID,
          short_code: '7F3A-09C2',
          expires_at: '2026-11-17T08:00:00Z',
          upload: { url: `/drop-blob/${ID}`, ticket: 'TICKET-PUT', expires_at: '2026-11-16T08:15:00Z' }
        });
      }
      if (call.url === `/drop-blob/${ID}` && call.method === 'PUT') {
        uploadAuth = new Headers(call.init?.headers).get('Authorization') ?? '';
        uploaded = await blobBytes(call.init?.body);
        return new Response(null, { status: 201 });
      }
      if (call.url.endsWith(`/api/drop/transfers/${ID}/sent`)) return json(200, { id: ID, status: 'sent' });
      return undefined;
    });
    const user = userEvent.setup();
    renderDrop();

    const content = `${MARKER} `.repeat(40);
    await user.upload(
      await screen.findByLabelText('File'),
      new File([content], 'piano-segreto.txt', { type: 'text/plain' })
    );
    await user.click(screen.getByRole('combobox', { name: 'Send to' }));
    await user.click(await screen.findByRole('option', { name: 'bruno' }));
    await user.click(screen.getByRole('radio', { name: /One download/ }));
    await user.click(screen.getByRole('button', { name: 'Encrypt and send' }));

    await screen.findByRole('heading', { level: 2, name: 'Sent to bruno' });
    const create = calls.find((c) => c.url.endsWith('/api/drop/transfers'));
    const sent = JSON.parse(String(create?.init?.body));
    expect(Object.keys(sent).sort()).toEqual(['ciphertext_bytes', 'one_time', 'recipient_id']);
    expect(sent.recipient_id).toBe('usr-bruno');
    expect(sent.one_time).toBe(true);
    expect(uploadAuth).toBe('NeroDrop TICKET-PUT');
    expect(uploaded).not.toBeNull();
    const cipher = uploaded as unknown as Uint8Array;
    expect(cipher.length).toBe(sent.ciphertext_bytes);
    const asText = new TextDecoder('latin1').decode(cipher);
    expect(asText).not.toContain(MARKER);
    expect(asText).not.toContain('piano-segreto');

    expect(screen.getByText('7F3A-09C2')).toBeInTheDocument();
    const link = screen.getByRole('textbox', { name: 'Link' }) as HTMLInputElement;
    expect(link.value).toMatch(new RegExp(`/drop#r=${ID}\\.[A-Za-z0-9_-]{43}$`));
    expect(await screen.findByRole('img', { name: /QR code/ })).toBeInTheDocument();

    // The key is in the link only: in no request, no storage, no address.
    const keyPart = link.value.split('.').at(-1) as string;
    for (const c of calls) {
      expect(c.url).not.toContain(keyPart);
      expect(typeof c.init?.body === 'string' ? c.init.body : '').not.toContain(keyPart);
    }
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(keyPart);
  });

  it('asks for a file and a recipient before sending', async () => {
    const calls = stubFetch();
    const user = userEvent.setup();
    renderDrop();
    await user.click(await screen.findByRole('button', { name: 'Encrypt and send' }));
    expect(await screen.findByText('Choose a file.')).toBeInTheDocument();
    expect(screen.getByText('Choose who to send it to.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('refuses a file over the limit before anything is sent', async () => {
    const calls = stubFetch(undefined, { config: { ...CONFIG, max_bytes: 2000 } });
    const user = userEvent.setup();
    renderDrop();
    await user.upload(await screen.findByLabelText('File'), new File(['x'.repeat(5000)], 'big.bin'));
    expect(await screen.findByText(/larger than/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('says plainly when the mailbox is not set up, and offers no form', async () => {
    stubFetch(undefined, { config: { ...CONFIG, available: false, may_send: false } });
    renderDrop();
    expect(await screen.findByText('NeroDrop is not set up yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Encrypt and send' })).toBeNull();
  });

  it('says when an administrator turned it off', async () => {
    stubFetch(undefined, { config: { ...CONFIG, enabled: false, may_send: false } });
    renderDrop();
    expect(await screen.findByText('NeroDrop is turned off for your organisation')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Encrypt and send' })).toBeNull();
  });

  it('has no accessibility violations', async () => {
    stubFetch(undefined, { inbox: [INBOX_ITEM] });
    const { container } = renderDrop();
    await screen.findByRole('button', { name: 'Encrypt and send' });
    await screen.findByText('From anna');
    await expectNoAxeViolations(container);
  });
});

describe('DropRoute: receive', () => {
  async function sealedFor(key: Uint8Array, text: string, name: string) {
    const data = new TextEncoder().encode(text);
    const parts = await encryptFile(
      { size: data.length, read: async (s, e) => data.slice(s, e) },
      { name, type: 'text/plain' },
      ID,
      key,
      { subtle: webcrypto.subtle }
    );
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }

  function receiving(cipher: Uint8Array) {
    return stubFetch(
      (call) => {
        if (call.url.endsWith(`/api/drop/transfers/${ID}/download-ticket`)) {
          return json(200, {
            url: `/drop-blob/${ID}`,
            ticket: 'TICKET-GET',
            expires_at: '2026-11-16T08:05:00Z',
            ciphertext_bytes: cipher.length
          });
        }
        if (call.url === `/drop-blob/${ID}`) return new Response(cipher as BodyInit, { status: 200 });
        if (call.url.endsWith(`/api/drop/transfers/${ID}/received`)) return json(200, { id: ID, status: 'received' });
        return undefined;
      },
      { inbox: [INBOX_ITEM] }
    );
  }

  it('opens the link, downloads, decrypts here and offers the file under its own name', async () => {
    const key = newFileKey(webcrypto);
    const cipher = await sealedFor(key, 'hello from anna', 'notes.txt');
    const calls = receiving(cipher);
    const user = userEvent.setup();
    const hash = new URL(buildDropLink('https://console.example.com', ID, key)).hash;
    renderDrop(`/drop${hash}`);

    expect(await screen.findByRole('heading', { level: 2, name: 'File from anna' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Download and decrypt' }));
    const save = await screen.findByRole('link', { name: 'Save notes.txt' });
    expect(save).toHaveAttribute('download', 'notes.txt');
    expect(save).toHaveAttribute('href', 'blob:drop');

    const get = calls.find((c) => c.url === `/drop-blob/${ID}`);
    expect(new Headers(get?.init?.headers).get('Authorization')).toBe('NeroDrop TICKET-GET');
    expect(calls.some((c) => c.url.endsWith(`/api/drop/transfers/${ID}/received`))).toBe(true);
    const keyText = toBase64Url(key);
    expect(calls.every((c) => !c.url.includes(keyText) && !String(c.init?.body ?? '').includes(keyText))).toBe(true);
  });

  it('says so when the link does not open the file, and offers nothing to save', async () => {
    const cipher = await sealedFor(newFileKey(webcrypto), 'secret', 'a.txt');
    const calls = receiving(cipher);
    const user = userEvent.setup();
    const wrong = new URL(buildDropLink('https://console.example.com', ID, newFileKey(webcrypto))).hash;
    renderDrop(`/drop${wrong}`);
    await user.click(await screen.findByRole('button', { name: 'Download and decrypt' }));
    expect(await screen.findByText(/This link does not open this file/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Save / })).toBeNull();
    expect(calls.some((c) => c.url.endsWith('/received'))).toBe(false);
  });

  it('opens a pasted link from the inbox', async () => {
    const key = newFileKey(webcrypto);
    receiving(await sealedFor(key, 'pasted', 'p.txt'));
    const user = userEvent.setup();
    renderDrop();
    expect(await screen.findByText('From anna')).toBeInTheDocument();
    expect(screen.getByText('7F3A-09C2')).toBeInTheDocument();
    await user.type(
      screen.getByRole('textbox', { name: 'Paste the link you received' }),
      buildDropLink('https://console.example.com', ID, key)
    );
    await user.click(screen.getByRole('button', { name: 'Open link' }));
    await user.click(await screen.findByRole('button', { name: 'Download and decrypt' }));
    await waitFor(() => expect(screen.getByRole('link', { name: 'Save p.txt' })).toBeInTheDocument());
  });

  it('shows an empty inbox that says what to do', async () => {
    stubFetch();
    renderDrop();
    expect(await screen.findByText('Nothing received')).toBeInTheDocument();
  });

  it('says so, with a retry, when the inbox cannot be loaded', async () => {
    let inboxCalls = 0;
    stubFetch((call) => {
      if (call.url.endsWith('/api/drop/inbox')) {
        inboxCalls += 1;
        return inboxCalls === 1 ? json(500, { error: 'boom', code: 'server_error' }) : json(200, { transfers: [] });
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderDrop();
    expect(await screen.findByText('Received files could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText('Nothing received')).toBeNull();
    await user.click(screen.getByRole('button', { name: /try again|retry/i }));
    expect(await screen.findByText('Nothing received')).toBeInTheDocument();
  });

  it('tells each received file that it needs the sender link, instead of a dead row', async () => {
    stubFetch(undefined, { inbox: [INBOX_ITEM] });
    renderDrop();
    expect(await screen.findByText('From anna')).toBeInTheDocument();
    expect(screen.getByText(/To open it, paste the link/)).toBeInTheDocument();
  });
});
