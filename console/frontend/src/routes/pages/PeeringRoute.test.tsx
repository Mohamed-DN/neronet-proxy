import { QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import PeeringRoute from './PeeringRoute';
import { clearSession, storeSession } from '../../services/authToken';
import { createQueryClient } from '../../services/queries/client';
import { decodeCode, encodeCode } from '../../services/queries/peering';
import { expectNoAxeViolations, renderUI } from '../../test/harness';
import i18n from '../../i18n';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

const AGREEMENT = {
  id: 'peer-1',
  peer_name: 'Rete Nord',
  initiator_endpoint: 'https://nord.example',
  scope_mode: 'SPECIFIC_SUBNETS',
  shared_subnets: ['10.0.0.0/8'],
  imported_nodes: [],
  status: 'active',
  expires_at: '2027-01-01T00:00:00Z'
};

const FINGERPRINT = 'AB12-CD34-EF56-7890-1234-5678-9ABC-DEF0';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Answers each request from `answers` by "METHOD /path" or "/path"; the last answer repeats. */
function stubApi(answers: Record<string, Array<() => Response>>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const path =
        String(input)
          .replace(/^\/api/, '')
          .split('?')[0] ?? '';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });
      const queue = answers[`${method} ${path}`] ?? answers[path];
      if (!queue || queue.length === 0) return json({}, 404);
      const answer = queue.length > 1 ? queue.shift()! : queue[0]!;
      return answer();
    }) as unknown as typeof fetch
  );
  return calls;
}

function renderPage(theme: 'light' | 'dark' = 'light') {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
  return renderUI(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/peering']}>
        <PeeringRoute />
      </MemoryRouter>
    </QueryClientProvider>,
    { theme }
  );
}

describe('PeeringRoute (links with other networks, on the real API)', () => {
  beforeEach(() => {
    localStorage.clear();
    storeSession({ token: 'test-token' });
  });

  afterEach(() => {
    clearSession();
    vi.unstubAllGlobals();
    void i18n.changeLanguage('en');
  });

  it('lists agreements from peering_agreements', async () => {
    stubApi({ '/peering': [() => json({ peering_agreements: [AGREEMENT], total: 1 })] });
    renderPage();

    expect(await screen.findByText('Rete Nord')).toBeInTheDocument();
  });

  it('create posts to /peering/request with the chosen scope and ranges', async () => {
    const calls = stubApi({
      '/peering': [() => json({ peering_agreements: [], total: 0 })],
      'POST /peering/request': [
        () => json({ peering_agreement: { peering_id: 'p1', initiator_endpoint: 'https://nord.example' } }, 201)
      ]
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Create a code for another network' }));
    await user.type(
      screen.getByRole('textbox', { name: 'Address of this network, as the other network will reach it' }),
      'https://nord.example'
    );
    await user.click(screen.getByRole('combobox', { name: 'What to share' }));
    await user.click(await screen.findByRole('option', { name: 'Only these address ranges' }));
    await user.type(
      screen.getByRole('textbox', { name: 'Shared networks (addresses, comma-separated)' }),
      '10.0.0.0/8'
    );
    await user.click(screen.getByRole('button', { name: 'Create code' }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.path === '/peering/request');
      expect(post?.body).toMatchObject({ scope_mode: 'SPECIFIC_SUBNETS', shared_subnets: ['10.0.0.0/8'] });
    });
  });

  it('ALL scope sends no default address range', async () => {
    const calls = stubApi({
      '/peering': [() => json({ peering_agreements: [], total: 0 })],
      'POST /peering/request': [() => json({ peering_agreement: { peering_id: 'p1' } }, 201)]
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Create a code for another network' }));
    await user.type(
      screen.getByRole('textbox', { name: 'Address of this network, as the other network will reach it' }),
      'https://nord.example'
    );
    await user.click(screen.getByRole('button', { name: 'Create code' }));

    await waitFor(() => expect(calls.some((c) => c.path === '/peering/request')).toBe(true));
    const post = calls.find((c) => c.path === '/peering/request');
    expect(JSON.stringify(post?.body)).not.toContain('100.64.0.0/16');
  });

  it('pasting a code asks for the fingerprint on 428, then resends it as expected_fingerprint', async () => {
    const code = encodeCode({ peering_id: 'p1', initiator_endpoint: 'https://nord.example', signature: 'sig' });
    const calls = stubApi({
      '/peering': [() => json({ peering_agreements: [], total: 0 })],
      'POST /peering/accept': [
        () => json({ error: 'Refusing to federate without an out-of-band check', fingerprint: FINGERPRINT }, 428),
        () => json({ success: true, peering_agreement: AGREEMENT })
      ]
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('tab', { name: 'Paste a code' }));
    await user.type(screen.getByRole('textbox', { name: 'Paste a code you received' }), code);
    await user.click(screen.getByRole('button', { name: 'Check and accept the code' }));

    expect(await screen.findByText(FINGERPRINT)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'The fingerprint matches, accept the code' }));

    await waitFor(() => {
      const accepts = calls.filter((c) => c.path === '/peering/accept');
      expect(accepts).toHaveLength(2);
      expect(accepts[1]?.body).toMatchObject({ expected_fingerprint: FINGERPRINT });
    });
    expect(await screen.findByText('Code accepted: the link has been created.')).toBeInTheDocument();
  });

  it('decodeCode ignores spaces and newlines in a pasted code', () => {
    const code = encodeCode({ peering_id: 'p1', name: 'Rete è nord' });
    const spaced = code.replace(/(.{4})/g, '$1\n  ');
    expect(decodeCode(spaced)).toEqual({ peering_id: 'p1', name: 'Rete è nord' });
  });

  it('revoke asks through ConfirmDialog, then sends DELETE', async () => {
    const calls = stubApi({
      '/peering': [() => json({ peering_agreements: [AGREEMENT], total: 1 })],
      'DELETE /peering/peer-1': [() => json({ success: true })]
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Revoke link' }));
    const dialog = await screen.findByRole('dialog', { name: 'Revoke the link with Rete Nord?' });
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Revoke link' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/peering/peer-1')).toBe(true));
  });

  it('has no latency, no relays-only option and no 3D text', async () => {
    stubApi({ '/peering': [() => json({ peering_agreements: [AGREEMENT], total: 1 })] });
    const { container } = renderPage();

    await screen.findByText('Rete Nord');
    expect(container.textContent).not.toMatch(/latency|latenza|relays only|solo i relay|3D/i);
  });

  it.each(['light', 'dark'] as const)('has no axe violations in %s theme', async (theme) => {
    stubApi({ '/peering': [() => json({ peering_agreements: [AGREEMENT], total: 1 })] });
    const { container, unmount } = renderPage(theme);
    await screen.findByText('Rete Nord');
    await expectNoAxeViolations(container, theme);
    unmount();
  });
});
