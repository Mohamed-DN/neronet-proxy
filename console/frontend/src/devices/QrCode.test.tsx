import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations, renderUI } from '../test/harness';
import { QrCode } from './QrCode';

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(async () => 'data:image/png;base64,AAA') }
}));

describe('QrCode', () => {
  it('renders the image with its label after loading', async () => {
    renderUI(<QrCode value="[Interface]" label="Configuration QR code" />);

    const image = await screen.findByRole('img', { name: 'Configuration QR code' });
    expect(image).toHaveAttribute('src', 'data:image/png;base64,AAA');
    expect(image).toHaveAttribute('width', '256');
  });

  it('encodes the value at medium error correction with a quiet zone', async () => {
    const qrcode = (await import('qrcode')).default;
    renderUI(<QrCode value="[Interface]" label="Configuration QR code" size={200} />);

    await screen.findByRole('img', { name: 'Configuration QR code' });
    expect(qrcode.toDataURL).toHaveBeenCalledWith('[Interface]', {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 200
    });
  });

  it('has no accessibility violations in light and dark', async () => {
    const light = renderUI(<QrCode value="x" label="QR" />, { theme: 'light' });
    await screen.findByRole('img', { name: 'QR' });
    await expectNoAxeViolations(light.container, 'light');
    light.unmount();

    const dark = renderUI(<QrCode value="x" label="QR" />, { theme: 'dark' });
    await screen.findByRole('img', { name: 'QR' });
    await expectNoAxeViolations(dark.container, 'dark');
  });
});
