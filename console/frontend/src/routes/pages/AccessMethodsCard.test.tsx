import { QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setLanguage } from '../../i18n';
import { createQueryClient } from '../../services/queries/client';
import { expectNoAxeViolations, renderUI } from '../../test/harness';
import { AccessMethodsCard } from './AccessMethodsCard';

// Switching a method off asks the server who it would affect (ADR 0037) before anything is saved.

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const SETTINGS = {
  organization_id: 'org-a',
  allowed_access_methods: ['wireguard', 'wireguard-wss', 'amneziawg'],
  wireguard_wss: true,
  amneziawg: true,
  amneziawg_ready: true
};
const NONE = { strands: [], strands_total: 0, reimport: [], reimport_total: 0 };

function render(plan: unknown, putStatus = 200, settings: Record<string, unknown> = SETTINGS) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith('/access-methods') && method === 'GET') return json(settings);
      if (url.endsWith('/access-methods/preview')) return json(plan);
      if (url.endsWith('/access-methods') && method === 'PUT') {
        return putStatus === 200
          ? json({ ...settings, ...(init?.body ? JSON.parse(String(init.body)) : {}), plan })
          : json(
              {
                error: 'would_strand_devices',
                code: 'would_strand_devices',
                devices: [{ id: 'd1', name: 'Ada phone' }]
              },
              putStatus
            );
      }
      return json({});
    }) as unknown as typeof fetch
  );
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
  const view = renderUI(
    <QueryClientProvider client={client}>
      <AccessMethodsCard orgId="org-a" user={{ role: 'admin' }} />
    </QueryClientProvider>
  );
  return { ...view, calls };
}

const puts = <T extends { method: string }>(calls: T[]) => calls.filter((c) => c.method === 'PUT');

describe('AccessMethodsCard: switching a method off', () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await setLanguage('en');
  });

  it('saves at once when no device is affected, after a preview', async () => {
    const u = userEvent.setup();
    const { calls, container } = render(NONE);
    const awg = await screen.findByRole('switch', { name: 'Networks that recognise VPNs (AmneziaWG)' });
    await expectNoAxeViolations(container);
    await u.click(awg);
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(calls.some((c) => c.url.endsWith('/preview'))).toBe(true);
    expect(puts(calls)[0]?.body).toEqual({ wireguard_wss: true, amneziawg: false, vless: false });
  });

  it('does not save and names the devices when some would have no way to connect', async () => {
    const u = userEvent.setup();
    const { calls } = render({ ...NONE, strands: [{ id: 'd1', name: 'Ada phone' }], strands_total: 1 });
    await u.click(await screen.findByRole('switch', { name: 'Networks that recognise VPNs (AmneziaWG)' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('1 device would have no way to connect');
    expect(alert).toHaveTextContent('Ada phone');
    expect(puts(calls)).toHaveLength(0);
  });

  it('asks before switching off a method whose profiles exist, then sends the confirmation', async () => {
    const u = userEvent.setup();
    const { calls } = render({
      ...NONE,
      reimport: [{ id: 'd2', name: 'Bruno laptop', access_method: 'amneziawg' }],
      reimport_total: 1
    });
    await u.click(await screen.findByRole('switch', { name: 'Networks that recognise VPNs (AmneziaWG)' }));
    const dialog = await screen.findByRole('dialog', { name: '1 device must download its profile again' });
    expect(dialog).toHaveTextContent('Bruno laptop');
    expect(puts(calls)).toHaveLength(0);
    await u.click(within(dialog).getByRole('button', { name: 'Switch it off' }));
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0]?.body).toEqual({
      wireguard_wss: true,
      amneziawg: false,
      vless: false,
      confirm_reimport: true
    });
  });

  it('keeps everything as it was when the person keeps the method on', async () => {
    const u = userEvent.setup();
    const { calls } = render({
      ...NONE,
      reimport: [{ id: 'd2', name: 'Bruno laptop', access_method: 'amneziawg' }],
      reimport_total: 1
    });
    await u.click(await screen.findByRole('switch', { name: 'Networks that recognise VPNs (AmneziaWG)' }));
    const dialog = await screen.findByRole('dialog');
    await u.click(within(dialog).getByRole('button', { name: 'Keep it on' }));
    expect(puts(calls)).toHaveLength(0);
  });

  it('shows the devices when the server refuses the save itself', async () => {
    const u = userEvent.setup();
    render(NONE, 409);
    await u.click(await screen.findByRole('switch', { name: 'Networks that recognise VPNs (AmneziaWG)' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Ada phone');
  });

  it('speaks Italian', async () => {
    await setLanguage('it');
    const u = userEvent.setup();
    render({ ...NONE, strands: [{ id: 'd1', name: 'Ada phone' }], strands_total: 1 });
    await u.click(await screen.findByRole('switch', { name: 'Reti che riconoscono le VPN (AmneziaWG)' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('1 dispositivo non avrebbe alcun modo per connettersi');
  });
});

describe('AccessMethodsCard: VLESS + REALITY (ADR 0036)', () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await setLanguage('en');
  });

  const OFF = { ...SETTINGS, vless: false, vless_ready: false };
  const ON = { ...SETTINGS, vless: true, vless_ready: true };

  it('switches it on with the secret keys made by the server, and says so', async () => {
    const u = userEvent.setup();
    const { calls } = render(NONE, 200, OFF);
    await u.click(await screen.findByRole('switch', { name: 'Heavily censored networks (VLESS)' }));
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(calls.some((c) => c.url.endsWith('/preview'))).toBe(false);
    expect(puts(calls)[0]?.body).toEqual({ wireguard_wss: true, amneziawg: true, vless: true });
    expect(await screen.findByText(/VLESS is on/)).toBeInTheDocument();
  });

  it('asks the server who it would affect before switching it off', async () => {
    const u = userEvent.setup();
    const { calls } = render(
      { ...NONE, reimport: [{ id: 'd3', name: 'Chiara phone', access_method: 'vless-reality' }], reimport_total: 1 },
      200,
      ON
    );
    await u.click(await screen.findByRole('switch', { name: 'Heavily censored networks (VLESS)' }));
    const dialog = await screen.findByRole('dialog', { name: '1 device must download its profile again' });
    expect(dialog).toHaveTextContent('Chiara phone');
    expect(puts(calls)).toHaveLength(0);
    expect(calls.find((c) => c.url.endsWith('/preview'))?.body).toEqual({
      wireguard_wss: true,
      amneziawg: true,
      vless: false
    });
  });

  it('explains a missing operator setting instead of failing silently', async () => {
    const u = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (url.endsWith('/access-methods') && method === 'GET') return json(OFF);
        if (url.endsWith('/access-methods') && method === 'PUT') {
          return json({ error: 'reality_dest_not_configured', code: 'reality_dest_not_configured' }, 409);
        }
        return json(NONE);
      }) as unknown as typeof fetch
    );
    const client = createQueryClient();
    client.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
    renderUI(
      <QueryClientProvider client={client}>
        <AccessMethodsCard orgId="org-a" user={{ role: 'admin' }} />
      </QueryClientProvider>
    );
    await u.click(await screen.findByRole('switch', { name: 'Heavily censored networks (VLESS)' }));
    expect(await screen.findByText(/NERONET_REALITY_DEST/)).toBeInTheDocument();
  });

  it('regenerates the keys only after a warning, and asks for the VLESS method', async () => {
    const u = userEvent.setup();
    const { calls } = render(NONE, 200, ON);
    await screen.findByRole('switch', { name: 'Heavily censored networks (VLESS)' });
    const buttons = screen.getAllByRole('button', { name: 'Regenerate the parameters' });
    await u.click(buttons[buttons.length - 1] as HTMLElement);
    const dialog = await screen.findByRole('dialog', { name: 'Regenerate the VLESS keys?' });
    expect(calls.filter((c) => c.url.endsWith('/regenerate'))).toHaveLength(0);
    await u.click(within(dialog).getByRole('button', { name: 'Regenerate' }));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/regenerate'))).toHaveLength(1));
    expect(calls.find((c) => c.url.endsWith('/regenerate'))?.body).toEqual({ method: 'vless-reality' });
  });

  it('speaks Italian: the label names the situation, not the protocol alone', async () => {
    await setLanguage('it');
    render(NONE, 200, OFF);
    expect(await screen.findByRole('switch', { name: 'Reti molto censurate (VLESS)' })).toBeInTheDocument();
  });
});
