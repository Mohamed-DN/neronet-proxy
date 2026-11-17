import { QueryClientProvider } from '@tanstack/react-query';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import i18n from '../i18n';
import { createQueryClient } from '../services/queries';
import { renderUI } from '../test/harness';
import Header from './Header';

const auth = vi.hoisted(() => ({ user: null as unknown }));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: auth.user, role: null, isAuthenticated: true, switchRole: () => {}, logout: async () => {} })
}));

function renderHeader(orgRole: string | null) {
  auth.user = { id: 'u1', username: 'someone', role: 'user', org_role: orgRole };
  return renderUI(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <Header onOpenEnrollModal={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('Header', () => {
  it('has no role switch and no search box', () => {
    renderHeader('owner');

    expect(screen.queryByRole('radiogroup', { name: /role/i })).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('hides Add device for an auditor, who can only read', () => {
    renderHeader('auditor');

    expect(screen.queryByRole('button', { name: i18n.t('header.enrol', { ns: 'chrome' }) })).toBeNull();
  });

  it('shows Add device for an owner', () => {
    renderHeader('owner');

    expect(screen.getByRole('button', { name: i18n.t('header.enrol', { ns: 'chrome' }) })).toBeInTheDocument();
  });

  it('shows the role label from the organisation role in the account menu', async () => {
    renderHeader('owner');

    await userEvent.click(screen.getByRole('button', { name: /^Account menu/ }));
    expect(await screen.findByText(i18n.t('roles.owner.term', { ns: 'glossary' }))).toBeInTheDocument();
  });

  it('closes the notifications popover with Escape and returns focus to the bell', async () => {
    renderHeader('owner');
    const bell = screen.getByRole('button', { name: i18n.t('header.notifications', { ns: 'chrome' }) });

    await userEvent.click(bell);
    const popover = await screen.findByRole('dialog', { name: i18n.t('header.alerts', { ns: 'chrome' }) });
    expect(popover).toContainElement(document.activeElement as HTMLElement);

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(bell).toHaveFocus();
  });

  it('closes the notifications popover on a click outside it', async () => {
    renderHeader('owner');

    await userEvent.click(screen.getByRole('button', { name: i18n.t('header.notifications', { ns: 'chrome' }) }));
    await screen.findByRole('dialog');

    await userEvent.click(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
