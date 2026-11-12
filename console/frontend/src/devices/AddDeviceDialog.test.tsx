import { QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '../i18n';
import { createQueryClient } from '../services/queries';
import { expectAccessibleInBothThemes, renderUI } from '../test/harness';
import AddDeviceDialog from './AddDeviceDialog';

const auth = vi.hoisted(() => ({ user: null as unknown }));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: auth.user, role: null, isAuthenticated: true })
}));

const t = (key: string) => i18n.t(`devices.${key}`, { ns: 'devices' });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function dialog(orgRole: string | null) {
  auth.user = { id: 'u1', username: 'someone', role: 'user', org_role: orgRole };
  return (
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <AddDeviceDialog open onOpenChange={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('AddDeviceDialog', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/preauth-keys') {
          return json({ id: 'k1', enrolment_string: 'abc-123', expires_at: '2026-11-11T00:00:00Z' });
        }
        return json({});
      }) as unknown as typeof fetch
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offers both choices to a network administrator', () => {
    renderUI(dialog('network_admin'));

    expect(screen.getByRole('radiogroup')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: t('profile.title') })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: t('agent.title') })).toBeInTheDocument();
  });

  it('offers only the phone or computer choice to a member', () => {
    renderUI(dialog('member'));

    expect(screen.getByRole('radio', { name: t('profile.title') })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: t('agent.title') })).toBeNull();
  });

  it('shows the agent key as SOVEREIGN_ENROLMENT_KEY=<string>', async () => {
    const user = userEvent.setup();
    renderUI(dialog('network_admin'));

    await user.click(screen.getByRole('radio', { name: t('agent.title') }));
    await user.click(screen.getByRole('button', { name: t('agent.create') }));

    expect(await screen.findByText('SOVEREIGN_ENROLMENT_KEY=abc-123')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(t('agent.expiry'))).toBeInTheDocument());
  });

  it('has no accessibility violations in light or dark', async () => {
    await expectAccessibleInBothThemes(dialog('network_admin'));
  });
});
