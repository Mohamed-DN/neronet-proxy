import { QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CloudPcRoute from './CloudPcRoute';
import { createQueryClient } from '../../services/queries/client';
import { expectNoAxeViolations, renderUI } from '../../test/harness';
import '../../i18n';

const INSTANCE = {
  id: 'cpc-01',
  name: 'Design desk',
  status: 'running',
  os_type: 'Ubuntu',
  resolution: '1920x1080',
  fps: 60,
  codec: 'H.264',
  cpu_cores: 4,
  memory_mb: 16384,
  storage_gb: 256,
  gpu_acceleration: false,
  webrtc_signaling_url: 'wss://signal.example.test'
};

const DOMAIN = {
  domain: 'desktop.company.com',
  cname_target: 'edge.example.test',
  cpc_id: 'cpc-01',
  cpc_name: 'Design desk',
  dns_status: 'active',
  ssl_status: 'valid',
  sso_enforced: true,
  otp_gateway_required: true
};

interface Call {
  method: string;
  url: string;
}

let calls: Call[];
let failLoad = false;

function json(data: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
  );
}

function stubApi() {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method !== 'GET') calls.push({ method, url });
      if (method === 'GET' && url.includes('/api/cloud-pc/custom-domains')) {
        return json({ custom_domains: [DOMAIN] });
      }
      if (method === 'GET' && url.endsWith('/api/cloud-pc')) {
        if (failLoad) return json({ error: 'boom' }, 500);
        return json({ instances: [INSTANCE] });
      }
      if (method === 'POST' && url.endsWith('/project')) {
        return json({
          viewer_url: 'https://viewer.example.test/session/abc',
          signaling_url: 'wss://signal.example.test',
          stream_token: 'tok-123',
          codec: 'H.264'
        });
      }
      if (method === 'POST' && url.endsWith('/verify')) {
        return json({ verified: false, reason: 'CNAME not found' });
      }
      if (method === 'DELETE') return json({ success: true });
      return json({});
    }) as unknown as typeof fetch
  );
}

function renderPage(theme: 'light' | 'dark' = 'light') {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
  return renderUI(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <CloudPcRoute />
      </MemoryRouter>
    </QueryClientProvider>,
    { theme }
  );
}

describe('Virtual computers page', () => {
  beforeEach(() => {
    failLoad = false;
    stubApi();
  });
  afterEach(() => vi.restoreAllMocks());

  it('removing a domain asks in a ConfirmDialog, not window.confirm', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('tab', { name: /Domains/ }));
    await user.click(await screen.findByRole('button', { name: 'Remove the link for desktop.company.com' }));

    const dialog = await screen.findByRole('dialog', { name: 'Remove the link for desktop.company.com?' });
    expect(confirm).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: 'Remove link' }));
    await waitFor(() =>
      expect(calls).toContainEqual({ method: 'DELETE', url: expect.stringContaining('desktop.company.com') })
    );
  });

  it('the access link says it will not connect yet', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Create an access link' }));

    expect(
      await screen.findByText('The link will not connect yet: the streaming service is not running.')
    ).toBeInTheDocument();
  });

  it('shows no hardware-encode or streaming-pipeline text', async () => {
    renderPage();
    await screen.findByText('Design desk');

    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/NVENC|VA-API|Hardware Encode|Video Pipeline|WebRTC|Sovereign/);
  });

  it('a failed load shows the error surface', async () => {
    failLoad = true;
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('The virtual computers could not be loaded. Try again.')).toBeInTheDocument();
  });

  it('has no axe violations in light and dark', async () => {
    for (const theme of ['light', 'dark'] as const) {
      const { container, unmount } = renderPage(theme);
      await screen.findByText('Design desk');
      await expectNoAxeViolations(container, theme);
      unmount();
    }
  });
});
