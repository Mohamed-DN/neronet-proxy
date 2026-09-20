import { QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearSession, storeSession } from '../authToken';
import { getConnectionState, resetConnectionState } from '../connection';
import { QueryBoundary } from '../../routes/QueryBoundary';
import { renderUI } from '../../test/harness';
import { createQueryClient } from './client';
import { useStatsOverview } from './stats';

/**
 * What an operator sees when the control plane stops answering.
 *
 * The failure that matters is not the request failing; it is the console
 * carrying on as though it had not. TanStack Query keeps the last successful
 * answer on a failed query, so a page that renders `data` goes on drawing a
 * fleet that may have vanished. These tests drive a real query client against a
 * transport that starts working and then stops.
 */

function Ticker() {
  const overview = useStatsOverview();
  return (
    <QueryBoundary query={overview}>
      {(data) => <p>{`active ${data.active_nodes} of ${data.total_nodes}`}</p>}
    </QueryBoundary>
  );
}

function renderWithClient(ui: React.ReactElement) {
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
  const result = renderUI(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return { client, ...result };
}

describe('a control plane that stops answering', () => {
  beforeEach(() => {
    localStorage.clear();
    resetConnectionState();
    storeSession({ token: 'tok' });
  });

  afterEach(() => {
    clearSession();
    vi.unstubAllGlobals();
  });

  it('shows the figures while the control plane answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ active_nodes: 6, total_nodes: 8 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
      )
    );

    renderWithClient(<Ticker />);

    expect(await screen.findByText('active 6 of 8')).toBeInTheDocument();
    await waitFor(() => expect(getConnectionState().status).toBe('online'));
  });

  it('replaces the figures with the error state when the transport dies, rather than keeping them', async () => {
    let alive = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (!alive) throw new TypeError('Failed to fetch');
        return new Response(JSON.stringify({ active_nodes: 6, total_nodes: 8 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );

    const { client } = renderWithClient(<Ticker />);
    expect(await screen.findByText('active 6 of 8')).toBeInTheDocument();

    alive = false;
    await client.refetchQueries();

    // The figures are gone, not stale on screen beside an error.
    await waitFor(() => expect(screen.queryByText('active 6 of 8')).not.toBeInTheDocument());
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load this view');
    expect(getConnectionState()).toMatchObject({ status: 'offline', lastError: 'Failed to fetch' });
  });

  it('never shows a zero in place of a figure it could not fetch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );

    renderWithClient(<Ticker />);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(/active 0 of 0/)).not.toBeInTheDocument();
  });

  it('recovers on retry once the control plane is back', async () => {
    let alive = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (!alive) throw new TypeError('Failed to fetch');
        return new Response(JSON.stringify({ active_nodes: 2, total_nodes: 2 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );

    renderWithClient(<Ticker />);
    const retry = await screen.findByRole('button', { name: 'Try again' });

    alive = true;
    await userEvent.click(retry);

    expect(await screen.findByText('active 2 of 2')).toBeInTheDocument();
    await waitFor(() => expect(getConnectionState().status).toBe('online'));
  });
});
