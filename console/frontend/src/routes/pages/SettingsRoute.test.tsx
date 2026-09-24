import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expectNoAxeViolations, renderUI } from '../../test/harness';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import SettingsRoute from './SettingsRoute';
import { ShellProvider } from '../shell';
import '../../i18n';

function renderSettings(initialEntries = ['/settings']) {
  return renderUI(
    <ShellProvider>
      <MemoryRouter initialEntries={initialEntries}>
        <Routes>
          <Route path="/settings" element={<SettingsRoute />} />
        </Routes>
      </MemoryRouter>
    </ShellProvider>
  );
}

describe('WP-410: SettingsRoute (Sovereign Mesh Global Configuration)', () => {
  it('1. Renders configuration cards, switches, inputs and passes axe-core accessibility in both themes', async () => {
    const { container } = renderSettings();

    // Verify sections
    expect(screen.getByText(/Tor-Grade 3-Hop Onion Circuits/i)).toBeInTheDocument();
    expect(screen.getByText(/WireGuard Engine & MTU Sizing/i)).toBeInTheDocument();
    expect(screen.getByText(/Telemetry, SIEM & Hardening/i)).toBeInTheDocument();

    // Verify accessibility in light theme
    await expectNoAxeViolations(container);

    // Verify accessibility in dark theme
    document.documentElement.setAttribute('data-theme', 'dark');
    await expectNoAxeViolations(container);
    document.documentElement.removeAttribute('data-theme');
  });

  it('2. Allows modifying settings and applying changes', async () => {
    const user = userEvent.setup();
    renderSettings();

    // Change MTU
    const mtuInput = screen.getByLabelText(/Interface MTU Size/i);
    await user.clear(mtuInput);
    await user.type(mtuInput, '1400');

    // Click Apply Configuration
    const applyBtn = screen.getByRole('button', { name: /apply configuration|applica configurazione/i });
    await user.click(applyBtn);

    // Feedback should appear
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /applied|applicata/i })).toBeInTheDocument();
    });
  });
});
