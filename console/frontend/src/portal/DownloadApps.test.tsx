import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations, renderUI } from '../test/harness';
import DownloadApps from './DownloadApps';

const MANIFEST = {
  apps: [
    {
      platform: 'android',
      version: '1.4.0',
      file: 'neronet-1.4.0.apk',
      size_bytes: 24_117_248,
      sha256: 'abc123def456'
    }
  ]
};

function stubFetch(answer: () => Response) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => answer());
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderApps(theme: 'light' | 'dark' = 'light') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderUI(
    <QueryClientProvider client={client}>
      <DownloadApps />
    </QueryClientProvider>,
    { theme }
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DownloadApps', () => {
  it('lists published apps with size and check code', async () => {
    const fetchMock = stubFetch(
      () => new Response(JSON.stringify(MANIFEST), { status: 200, headers: { 'content-type': 'application/json' } })
    );

    renderApps();

    const link = await screen.findByRole('link', { name: 'Download for Android' });
    expect(link).toHaveAttribute('href', '/downloads/neronet-1.4.0.apk');
    expect(screen.getByText(/NeroNet for Android, version 1\.4\.0/)).toBeInTheDocument();
    expect(screen.getByText('Check code (SHA-256): abc123def456')).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/downloads\/manifest\.json$/);
  });

  it('an HTML answer (SPA fallback) counts as not published', async () => {
    stubFetch(
      () => new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } })
    );

    renderApps();

    await waitFor(() =>
      expect(
        screen.getByText('NeroNet for Windows is not published yet. Use the WireGuard app for now.')
      ).toBeInTheDocument()
    );
    expect(screen.queryByRole('link', { name: 'Download for Android' })).toBeNull();
  });

  it('a failed request counts as not published, and iOS always points to the WireGuard app', async () => {
    stubFetch(() => new Response('gone', { status: 404 }));

    renderApps();

    await waitFor(() =>
      expect(
        screen.getByText('NeroNet for macOS is not published yet. Use the WireGuard app for now.')
      ).toBeInTheDocument()
    );
    const appStore = screen.getByRole('link', { name: /WireGuard on the App Store/ });
    expect(appStore).toHaveAttribute('href', 'https://apps.apple.com/app/wireguard/id1441195209');
    expect(appStore).toHaveAttribute('rel', 'noopener noreferrer');
    expect(appStore).toHaveAttribute('target', '_blank');
    expect(screen.getByText(/On iPhone and iPad, install the official WireGuard app/)).toBeInTheDocument();
  });

  it('is accessible in both themes', async () => {
    stubFetch(
      () => new Response(JSON.stringify(MANIFEST), { status: 200, headers: { 'content-type': 'application/json' } })
    );

    const light = renderApps('light');
    await screen.findByRole('link', { name: 'Download for Android' });
    await expectNoAxeViolations(light.container, 'light');
    light.unmount();

    const dark = renderApps('dark');
    await screen.findByRole('link', { name: 'Download for Android' });
    await expectNoAxeViolations(dark.container, 'dark');
    dark.unmount();
  });
});
