import { QueryClientProvider, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { StrictMode, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider, useAuth } from './AuthContext';
import AuditRoute from '../routes/pages/AuditRoute';
import { ShellProvider } from '../routes/shell';
import { createQueryClient } from '../services/queries/client';
import { clearSession } from '../services/authToken';
import type { ConsoleUser } from '../services/session';
import { renderUI } from '../test/harness';

const observedClients = new Set<QueryClient>();

function Workspace() {
  const auth = useAuth();
  const client = useQueryClient();
  useEffect(() => {
    observedClients.add(client);
  }, [client]);
  if (auth.loading) return <p>Restoring test session</p>;
  return (
    <>
      <button onClick={() => void auth.login('auditor-a', 'fixture-password')}>Sign in A</button>
      <button onClick={() => void auth.login('auditor-b', 'fixture-password')}>Sign in B</button>
      <button onClick={() => void auth.login('platform', 'fixture-password')}>Sign in platform</button>
      <button onClick={() => void auth.logout()}>End session</button>
      <button onClick={() => void auth.refreshUser()}>Revalidate account</button>
      <button onClick={() => auth.switchRole(auth.role ?? 'user')}>Keep current role</button>
      <span data-testid="accepted-account" data-role={auth.user?.role}>
        {auth.user?.username ?? 'signed out'}
      </span>
      {auth.isAuthenticated && <AuditRoute />}
    </>
  );
}

describe('Audit cache follows the accepted console session', () => {
  let accepted: ConsoleUser | null;
  let visibleEvent: string;
  let nextUser: ConsoleUser | null;
  let nextEvent: string;
  let nextAbsent: boolean;
  let delayAuditA: boolean;
  let releaseLate: ((response: Response) => void) | undefined;
  let lateSignal: AbortSignal | null | undefined;

  beforeEach(() => {
    clearSession();
    accepted = null;
    visibleEvent = '';
    nextUser = null;
    nextEvent = '';
    nextAbsent = false;
    delayAuditA = false;
    releaseLate = undefined;
    lateSignal = undefined;
    observedClients.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
        if (url.includes('/auth/refresh')) return json({ error: 'No test refresh cookie' }, 401);
        if (url.includes('/auth/login')) {
          const username = JSON.parse(String(init?.body)).username;
          accepted = {
            id: `usr-${username}`,
            username,
            role: username === 'platform' ? 'super-admin' : 'user',
            organization_id: username === 'auditor-b' ? 'org-b' : 'org-a'
          };
          visibleEvent = username === 'platform' ? 'PLATFORM_ONLY_AUDIT_CONTENT' : `${username}_PRIVATE_AUDIT_CONTENT`;
          return json({ token: `fixture-session-${username}`, user: accepted });
        }
        if (url.includes('/auth/logout')) {
          accepted = null;
          return json({ success: true });
        }
        if (url.includes('/auth/me')) {
          if (nextAbsent) {
            accepted = null;
            return json({ user: null });
          }
          accepted = nextUser ?? accepted;
          visibleEvent = nextEvent || visibleEvent;
          return json({ user: accepted });
        }
        if (url.includes('/audit/events') && delayAuditA && accepted?.username === 'auditor-a') {
          return new Promise<Response>((resolve, reject) => {
            releaseLate = resolve;
            lateSignal = init?.signal;
            lateSignal?.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted fixture fetch', 'AbortError')),
              { once: true }
            );
          });
        }
        if (url.includes('/audit/events'))
          return json({
            audit_logs: [
              {
                id: visibleEvent,
                sequence_num: 1,
                event_type: 'AUDIT_SCOPE_FIXTURE',
                message: visibleEvent,
                created_at: '2026-10-29T08:00:00Z'
              }
            ]
          });
        if (url.includes('/audit/verify'))
          return json({
            verification: {
              valid: true,
              integrity_profile: 'canonical-v3',
              events_count: 1,
              canonical_v3_events: 1,
              organization_attributed_events: 1,
              unattributed_events: 0
            }
          });
        if (url.includes('/audit/checkpoints')) return json({ checkpoints: [] });
        if (url.includes('/audit/siem')) return json({ destinations: [] });
        return json({ error: 'Unexpected UI fixture endpoint' }, 404);
      })
    );
  });
  afterEach(() => {
    clearSession();
    vi.unstubAllGlobals();
  });

  function renderWorkspace(strictMode = false) {
    // Production AuthProvider, queries and route; the same outer client survives
    // every transition, as App did before session isolation. Only HTTP is a DTO
    // fixture here; actual server/browser session changes remain a runtime gate.
    const client = createQueryClient();
    client.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
    const workspace = (
      <QueryClientProvider client={client}>
        <AuthProvider>
          <ShellProvider>
            <MemoryRouter>
              <Workspace />
            </MemoryRouter>
          </ShellProvider>
        </AuthProvider>
      </QueryClientProvider>
    );
    return renderUI(strictMode ? <StrictMode>{workspace}</StrictMode> : workspace);
  }

  it('does not reuse a fresh tenant A cache after logout and sign-in as tenant B', async () => {
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign in A' }));
    expect(await screen.findByText('auditor-a_PRIVATE_AUDIT_CONTENT')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'End session' }));
    expect(await screen.findByTestId('accepted-account')).toHaveTextContent('signed out');
    await user.click(screen.getByRole('button', { name: 'Sign in B' }));
    expect(await screen.findByTestId('accepted-account')).toHaveTextContent('auditor-b');
    expect(screen.queryByText('auditor-a_PRIVATE_AUDIT_CONTENT')).not.toBeInTheDocument();
    expect(await screen.findByText('auditor-b_PRIVATE_AUDIT_CONTENT')).toBeInTheDocument();
  });

  it('discards old permissions on server revalidation even when the public account DTO is unchanged', async () => {
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign in A' }));
    expect(await screen.findByText('auditor-a_PRIVATE_AUDIT_CONTENT')).toBeInTheDocument();
    nextEvent = 'AFTER_PERMISSION_REVALIDATION';
    await user.click(screen.getByRole('button', { name: 'Revalidate account' }));
    expect(await screen.findByText('AFTER_PERMISSION_REVALIDATION')).toBeInTheDocument();
    expect(screen.queryByText('auditor-a_PRIVATE_AUDIT_CONTENT')).not.toBeInTheDocument();
  });

  it('closes a platform verification report when the account loses its platform role', async () => {
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign in platform' }));
    expect(await screen.findByText('PLATFORM_ONLY_AUDIT_CONTENT')).toBeInTheDocument();
    await user.click(await screen.findByTestId('verify-chain-button'));
    expect(await screen.findByTestId('verification-pass-card')).toBeInTheDocument();
    nextUser = { ...accepted!, role: 'user' };
    nextEvent = 'AFTER_PLATFORM_DEMOTION';
    // The fixture's control is outside the dialog, so invoke the already-rendered
    // control directly rather than pretending a protected modal is pointer-free.
    await act(async () => {
      screen.getByText('Revalidate account', { selector: 'button' }).click();
    });
    await waitFor(() => expect(screen.getByTestId('accepted-account')).toHaveAttribute('data-role', 'user'));
    expect(screen.queryByTestId('verification-pass-card')).not.toBeInTheDocument();
    expect(await screen.findByText('AFTER_PLATFORM_DEMOTION')).toBeInTheDocument();
    expect(screen.queryByText('PLATFORM_ONLY_AUDIT_CONTENT')).not.toBeInTheDocument();
  });

  it('forgets the session and its audit view when revalidation returns no admitted account', async () => {
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign in A' }));
    expect(await screen.findByText('auditor-a_PRIVATE_AUDIT_CONTENT')).toBeInTheDocument();
    nextAbsent = true;
    await user.click(screen.getByRole('button', { name: 'Revalidate account' }));
    await waitFor(() => expect(screen.getByTestId('accepted-account')).toHaveTextContent('signed out'));
    expect(screen.queryByText('auditor-a_PRIVATE_AUDIT_CONTENT')).not.toBeInTheDocument();
  });

  it('keeps the replacement cache usable through StrictMode effect cleanup', async () => {
    renderWorkspace(true);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign in A' }));
    expect(await screen.findByText('auditor-a_PRIVATE_AUDIT_CONTENT')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'End session' }));
    await user.click(await screen.findByRole('button', { name: 'Sign in B' }));
    expect(await screen.findByText('auditor-b_PRIVATE_AUDIT_CONTENT')).toBeInTheDocument();
    expect(screen.queryByText('auditor-a_PRIVATE_AUDIT_CONTENT')).not.toBeInTheDocument();
  });

  it('preserves the current filter when the already-selected role is selected again', async () => {
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign in A' }));
    expect(await screen.findByText('auditor-a_PRIVATE_AUDIT_CONTENT')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Filter audit events search' }), 'auditor-a');
    await user.click(screen.getByRole('button', { name: 'Keep current role' }));
    expect(screen.getByRole('textbox', { name: 'Filter audit events search' })).toHaveValue('auditor-a');
  });

  it('clears the retired client while preserving the replacement client data', async () => {
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign in A' }));
    expect(await screen.findByText('auditor-a_PRIVATE_AUDIT_CONTENT')).toBeInTheDocument();
    const previous = Array.from(observedClients).slice(-1)[0];
    if (!previous) throw new Error('The actual admitted session QueryClient was not observed');
    expect(previous.getQueryCache().getAll().length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'End session' }));
    await user.click(await screen.findByRole('button', { name: 'Sign in B' }));
    expect(await screen.findByText('auditor-b_PRIVATE_AUDIT_CONTENT')).toBeInTheDocument();
    const replacement = Array.from(observedClients).slice(-1)[0];
    if (!replacement) throw new Error('The replacement session QueryClient was not observed');
    expect(replacement).not.toBe(previous);
    await waitFor(() => expect(previous.getQueryCache().getAll()).toHaveLength(0));
    expect(
      replacement
        .getQueryCache()
        .getAll()
        .some((query) => JSON.stringify(query.state.data)?.includes('auditor-b_PRIVATE_AUDIT_CONTENT'))
    ).toBe(true);
  });

  it('aborts the retired request and never displays its late response in the replacement session', async () => {
    delayAuditA = true;
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign in A' }));
    await waitFor(() => expect(releaseLate).toBeTypeOf('function'));
    await user.click(screen.getByRole('button', { name: 'End session' }));
    await waitFor(() => expect(lateSignal?.aborted).toBe(true));
    await user.click(await screen.findByRole('button', { name: 'Sign in B' }));
    expect(await screen.findByText('auditor-b_PRIVATE_AUDIT_CONTENT')).toBeInTheDocument();
    await act(async () => {
      releaseLate!(
        new Response(
          JSON.stringify({
            audit_logs: [
              {
                id: 'late-a',
                sequence_num: 1,
                event_type: 'LATE_A',
                message: 'LATE_A_PRIVATE_CONTENT',
                created_at: '2026-10-29T08:00:00Z'
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
    });
    expect(screen.queryByText('LATE_A_PRIVATE_CONTENT')).not.toBeInTheDocument();
    expect(screen.getByText('auditor-b_PRIVATE_AUDIT_CONTENT')).toBeInTheDocument();
  });
});
