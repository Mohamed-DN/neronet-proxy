import { describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { screen } from '@testing-library/react';

import { renderUI } from '../test/harness';
import CryptoConfigModal from './CryptoConfigModal.jsx';

vi.mock('../services/api', () => ({ api: {} }));

describe('CryptoConfigModal onion toggle', () => {
  it('exposes the 3-hop toggle as a named switch that reports its state', async () => {
    const user = userEvent.setup();
    renderUI(<CryptoConfigModal isOpen onClose={() => {}} onNodeEnrolled={() => {}} />);

    const toggle = screen.getByRole('switch', { name: '3-Hop Onion Obfuscation' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });
});
