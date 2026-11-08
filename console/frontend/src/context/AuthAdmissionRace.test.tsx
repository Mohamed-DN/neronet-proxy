import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider, useAuth } from './AuthContext';
import { clearSession, readAccessToken, storeAccessToken, storeSession } from '../services/authToken';
import { renderUI } from '../test/harness';
import { apiRequest } from '../services/apiClient';

const accountA = { id: 'account-a', username: 'Account A', role: 'user', organization_id: 'org-a' };
const accountB = { id: 'account-b', username: 'Account B', role: 'user', organization_id: 'org-b' };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function Controls({ observe }: { observe: (operation: Promise<void>) => void }) {
  const auth = useAuth();
  return (
    <>
      <span data-testid="account" data-role={auth.user?.role}>
        {auth.user?.id ?? 'none'}
      </span>
      <span data-testid="boot">{auth.loading ? 'loading' : 'ready'}</span>
      <button onClick={() => observe(auth.refreshUser().catch(() => {}))}>Revalidate A</button>
      <button onClick={() => observe(auth.logout())}>Logout</button>
      <button
        onClick={() =>
          observe(
            apiRequest('/protected-probe').then(
              () => {},
              () => {}
            )
          )
        }
      >
        Probe protected API
      </button>
      <button
        onClick={() =>
          observe(
            auth.login('account-b', 'fixture-password').then(
              () => {},
              () => {}
            )
          )
        }
      >
        Login B
      </button>
    </>
  );
}

describe('Console admission ignores obsolete account reads', () => {
  let holdRead: boolean;
  let finishRead: ((response: Response) => void) | undefined;
  let observed: Promise<void> | undefined;
  let holdLogin: boolean;
  let finishLogin: ((response: Response) => void) | undefined;
  let refuseRefresh: boolean;
  beforeEach(() => {
    clearSession();
    storeSession({ token: 'fixture-access-a', role: 'user' });
    holdRead = false;
    finishRead = undefined;
    observed = undefined;
    holdLogin = false;
    finishLogin = undefined;
    refuseRefresh = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/auth/me') {
          if (holdRead)
            return new Promise<Response>((resolve) => {
              finishRead = resolve;
            });
          return json({ user: accountA });
        }
        if (url === '/api/auth/login') {
          if (holdLogin)
            return new Promise<Response>((resolve) => {
              finishLogin = resolve;
            });
          return json({ token: 'fixture-access-b', user: accountB });
        }
        if (url === '/api/auth/logout') return json({ success: true });
        if (refuseRefresh && (url === '/api/protected-probe' || url === '/api/auth/refresh'))
          return json({ error: 'Session revoked' }, 401);
        return json({ error: 'Unexpected admission fixture endpoint' }, 404);
      })
    );
  });
  afterEach(() => {
    clearSession();
    vi.unstubAllGlobals();
  });
  function renderControls() {
    renderUI(
      <AuthProvider>
        <Controls
          observe={(operation) => {
            observed = operation;
          }}
        />
      </AuthProvider>
    );
  }
  async function pendingRead() {
    renderControls();
    await waitFor(() => expect(screen.getByTestId('account')).toHaveTextContent(accountA.id));
    holdRead = true;
    await userEvent.click(screen.getByRole('button', { name: 'Revalidate A' }));
    await waitFor(() => expect(finishRead).toBeTypeOf('function'));
    const pending = observed;
    if (!pending) throw new Error('The real refreshUser operation was not observed');
    return { pending };
  }

  it('does not restore A after its account read completes following logout', async () => {
    const { pending } = await pendingRead();
    await userEvent.click(screen.getByRole('button', { name: 'Logout' }));
    await waitFor(() => expect(screen.getByTestId('account')).toHaveTextContent('none'));
    await act(async () => {
      finishRead!(json({ user: accountA }));
      await pending;
    });
    expect(screen.getByTestId('account')).toHaveTextContent('none');
    expect(readAccessToken()).toBeNull();
  });

  it('does not replace an admitted B with a late successful account A read', async () => {
    const { pending } = await pendingRead();
    await userEvent.click(screen.getByRole('button', { name: 'Logout' }));
    await userEvent.click(screen.getByRole('button', { name: 'Login B' }));
    await waitFor(() => expect(screen.getByTestId('account')).toHaveTextContent(accountB.id));
    await act(async () => {
      finishRead!(json({ user: accountA }));
      await pending;
    });
    expect(screen.getByTestId('account')).toHaveTextContent(accountB.id);
    expect(readAccessToken()).toBe('fixture-access-b');
  });

  it('does not forget B when an obsolete account A read fails', async () => {
    const { pending } = await pendingRead();
    await userEvent.click(screen.getByRole('button', { name: 'Logout' }));
    await userEvent.click(screen.getByRole('button', { name: 'Login B' }));
    await waitFor(() => expect(screen.getByTestId('account')).toHaveTextContent(accountB.id));
    await act(async () => {
      finishRead!(json({ error: 'A has been revoked' }, 401));
      await pending;
    });
    expect(screen.getByTestId('account')).toHaveTextContent(accountB.id);
    expect(readAccessToken()).toBe('fixture-access-b');
  });

  it('keeps the latest admitted permissions when two reads of the same account finish out of order', async () => {
    const { pending: first } = await pendingRead();
    const finishFirst = finishRead;
    await userEvent.click(screen.getByRole('button', { name: 'Revalidate A' }));
    const second = observed;
    const finishSecond = finishRead;
    if (!second || !finishSecond || !finishFirst || finishFirst === finishSecond)
      throw new Error('The second real account read did not start');
    await act(async () => {
      finishSecond(json({ user: { ...accountA, role: 'user' } }));
      await second;
    });
    await act(async () => {
      finishFirst(json({ user: { ...accountA, role: 'super-admin' } }));
      await first;
    });
    expect(screen.getByTestId('account')).toHaveAttribute('data-role', 'user');
  });

  for (const success of [true, false]) {
    it(`ignores a ${success ? 'successful' : 'failed'} account read dispatched before credential rotation`, async () => {
      const { pending } = await pendingRead();
      storeAccessToken('fixture-a-revision-2');
      await act(async () => {
        finishRead!(
          success
            ? json({ user: { ...accountA, role: 'super-admin' } })
            : json({ error: 'Old credential refused' }, 401)
        );
        await pending;
      });
      expect(screen.getByTestId('account')).toHaveTextContent(accountA.id);
      expect(screen.getByTestId('account')).toHaveAttribute('data-role', 'user');
      expect(readAccessToken()).toBe('fixture-a-revision-2');
    });
  }

  it('does not let an account read supersede the pending B credential admission', async () => {
    renderControls();
    await waitFor(() => expect(screen.getByTestId('account')).toHaveTextContent(accountA.id));
    holdLogin = true;
    await userEvent.click(screen.getByRole('button', { name: 'Login B' }));
    await waitFor(() => expect(finishLogin).toBeTypeOf('function'));
    const login = observed;
    if (!login) throw new Error('The actual B sign-in was not observed');
    await userEvent.click(screen.getByRole('button', { name: 'Revalidate A' }));
    await act(async () => {
      await observed;
    });
    await act(async () => {
      finishLogin!(json({ token: 'fixture-access-b', user: accountB }));
      await login;
    });
    expect(readAccessToken()).toBe('fixture-access-b');
    expect(screen.getByTestId('account')).toHaveTextContent(accountB.id);
  });

  it('retires the admitted account when an API refresh really refuses the current credential', async () => {
    renderControls();
    await waitFor(() => expect(screen.getByTestId('account')).toHaveTextContent(accountA.id));
    refuseRefresh = true;
    await userEvent.click(screen.getByRole('button', { name: 'Probe protected API' }));
    await act(async () => {
      await observed;
    });
    expect(readAccessToken()).toBeNull();
    expect(screen.getByTestId('account')).toHaveTextContent('none');
  });
});
