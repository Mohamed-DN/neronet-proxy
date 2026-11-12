import { QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '../services/queries';
import { queryKeys } from '../services/queries/keys';
import type { MeshNode } from '../services/types';
import { expectNoAxeViolations, renderUI } from '../test/harness';
import type { ThemeName } from '../ui/tokens';
import CommandMenu from './CommandMenu';

const auth = vi.hoisted(() => ({ user: null as unknown }));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: auth.user, role: null, isAuthenticated: true, switchRole: () => {}, logout: async () => {} })
}));

const OWNER = { id: 'u1', username: 'ana', role: 'user', org_role: 'owner' };
const AUDITOR = { id: 'u2', username: 'lee', role: 'user', org_role: 'auditor' };
const DEVICES: MeshNode[] = [{ id: 'node-7', name: 'branch-router-west', overlay_ipv4: '100.64.1.7' }];

const CTRL_K = '{Control>}k{/Control}';

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname}</output>;
}

function renderMenu({
  role = OWNER,
  theme = 'light' as ThemeName,
  devices = DEVICES
}: { role?: unknown; theme?: ThemeName; devices?: MeshNode[] } = {}) {
  auth.user = role;
  const queryClient = createQueryClient();
  queryClient.setQueryData(queryKeys.nodes, devices);
  queryClient.setQueryData(queryKeys.features, { cloud_pc: false });
  const onAddDevice = vi.fn();
  const view = renderUI(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/overview']}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <CommandMenu onAddDevice={onAddDevice} />
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
    { theme }
  );
  return { ...view, onAddDevice };
}

describe('CommandMenu (Ctrl/Cmd+K)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('Ctrl+K opens the menu and focuses the input', async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.keyboard(CTRL_K);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('combobox')).toHaveFocus();
  });

  it('Cmd+K opens the menu on a Mac keyboard', async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.keyboard('{Meta>}k{/Meta}');

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('typing "dev" lists Devices, and Enter opens the device list', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.keyboard(CTRL_K);

    await user.keyboard('dev');
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByRole('option', { name: 'Devices' })).toBeInTheDocument();

    await user.keyboard('{Enter}');

    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/nodes'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('an auditor does not see Users or Add device', async () => {
    const user = userEvent.setup();
    renderMenu({ role: AUDITOR });
    await user.keyboard(CTRL_K);

    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByRole('option', { name: 'Devices' })).toBeInTheDocument();
    expect(within(listbox).queryByRole('option', { name: 'Users' })).not.toBeInTheDocument();
    expect(within(listbox).queryByRole('option', { name: 'Add device' })).not.toBeInTheDocument();
  });

  it('a device name match opens that device', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.keyboard(CTRL_K);

    await user.keyboard('branch');
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getByRole('option', { name: 'branch-router-west' }));

    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/nodes/node-7'));
  });

  it('Add device runs the enrol action and closes the menu', async () => {
    const user = userEvent.setup();
    const { onAddDevice } = renderMenu();
    await user.keyboard(CTRL_K);

    await user.keyboard('add device');
    console.log(
      'DBG26',
      document.querySelector('[role=listbox]')?.textContent ?? 'none',
      (document.querySelector('[role=combobox]') as HTMLInputElement)?.value
    );
    await user.keyboard('{Enter}');

    expect(onAddDevice).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('the trigger names the menu and shows the shortcut, not a raw key', async () => {
    renderMenu();

    const trigger = screen.getByRole('button', { name: 'Search pages and devices' });
    expect(trigger).toHaveTextContent('Search');
    expect(trigger).toHaveTextContent('Ctrl K');
  });

  it('says so when nothing matches, quoting what was typed', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.keyboard(CTRL_K);

    await user.keyboard('zzq');

    expect(await screen.findByRole('status')).toHaveTextContent('No page or device matches “zzq”.');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('the open menu has no axe violations in light and dark themes', async () => {
    const user = userEvent.setup();
    for (const theme of ['light', 'dark'] as const) {
      const { unmount } = renderMenu({ theme });
      await user.keyboard(CTRL_K);
      await screen.findByRole('dialog');
      await expectNoAxeViolations(document.body, theme);
      unmount();
    }
  });
});
