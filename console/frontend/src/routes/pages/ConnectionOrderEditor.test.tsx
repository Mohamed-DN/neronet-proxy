import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setLanguage } from '../../i18n';
import { ApiError } from '../../services/apiClient';
import type { AccessMethodId, ChangePlan, OrderChange } from '../../services/queries/connectionOrder';
import { expectNoAxeViolations, renderUI } from '../../test/harness';
import { ConnectionOrderEditor, type ConnectionOrderEditorProps } from './ConnectionOrderEditor';

const ALL: AccessMethodId[] = ['wireguard', 'wireguard-wss', 'amneziawg'];
const NO_PLAN: ChangePlan = { strands: [], strands_total: 0, reimport: [], reimport_total: 0 };

function setup(extra: Partial<ConnectionOrderEditorProps> = {}) {
  const onSave = vi.fn(async (_next: OrderChange) => {});
  const props: ConnectionOrderEditorProps = {
    idPrefix: 't',
    allowed: ALL,
    own: { order: ['wireguard', 'wireguard-wss'], forced: false },
    inherited: { order: ALL, origin: { scope: 'default' } },
    inheritLabel: 'Automatic',
    mayEdit: true,
    onSave,
    ...extra
  };
  const view = renderUI(<ConnectionOrderEditor {...props} />);
  return { ...view, onSave };
}

const rows = () => within(screen.getByRole('list', { name: /ways to connect/i })).getAllByRole('listitem');
const names = () => rows().map((row) => within(row).getByRole('switch').getAttribute('aria-label'));

describe('ConnectionOrderEditor', () => {
  afterEach(async () => {
    await setLanguage('en');
  });

  it('shows the inherited order in words, and passes axe in both modes', async () => {
    const { container } = setup({ own: { order: null, forced: false } });
    expect(screen.getByText('It tries: WireGuard, then port 443, then AmneziaWG (Automatic).')).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    await expectNoAxeViolations(container);
    await userEvent.setup().click(screen.getByRole('radio', { name: 'Custom' }));
    expect(screen.getByRole('list', { name: /ways to connect/i })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('lists the enabled methods in order, then the switched-off ones', () => {
    setup();
    expect(names()).toEqual(['Use WireGuard', 'Use port 443', 'Use AmneziaWG']);
    const [, , last] = rows();
    expect(within(last!).getByRole('switch')).not.toBeChecked();
  });

  it('moves a method with the buttons, announces it, and saves the new order', async () => {
    const u = userEvent.setup();
    const { onSave } = setup();
    await u.click(screen.getByRole('button', { name: 'Move port 443 up' }));
    expect(names()).toEqual(['Use port 443', 'Use WireGuard', 'Use AmneziaWG']);
    expect(screen.getByRole('status')).toHaveTextContent('port 443 is now number 1 of 2.');
    expect(screen.getByRole('button', { name: 'Move port 443 up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move WireGuard down' })).toBeDisabled();
    await u.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ order: ['wireguard-wss', 'wireguard'], forced: false }));
  });

  it('reaches every control from the keyboard', async () => {
    const u = userEvent.setup();
    setup();
    const down = screen.getByRole('button', { name: 'Move WireGuard down' });
    down.focus();
    await u.keyboard('{Enter}');
    expect(names()[0]).toBe('Use port 443');
  });

  it('reorders by dragging a row onto another', () => {
    setup();
    const [first, second] = rows();
    fireEvent.dragStart(second!);
    fireEvent.dragOver(first!);
    fireEvent.drop(first!);
    expect(names()).toEqual(['Use port 443', 'Use WireGuard', 'Use AmneziaWG']);
  });

  it('switching a method off sinks it, and the last enabled one cannot be switched off', async () => {
    const u = userEvent.setup();
    const { onSave } = setup();
    await u.click(screen.getByRole('switch', { name: 'Use WireGuard' }));
    expect(names()).toEqual(['Use port 443', 'Use AmneziaWG', 'Use WireGuard']);
    expect(screen.getByRole('switch', { name: 'Use port 443' })).toBeDisabled();
    await u.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ order: ['wireguard-wss'], forced: false }));
  });

  it('forces only the first and says which one', async () => {
    const u = userEvent.setup();
    const { onSave } = setup();
    expect(screen.getByText('Only WireGuard is used, with no fallback to the others.')).toBeInTheDocument();
    await u.click(screen.getByRole('switch', { name: 'Force only the first' }));
    await u.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ order: ['wireguard', 'wireguard-wss'], forced: true }));
  });

  it('goes back to inheriting with a null order', async () => {
    const u = userEvent.setup();
    const { onSave } = setup();
    await u.click(screen.getByRole('radio', { name: 'Automatic' }));
    await u.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ order: null, forced: false }));
  });

  it('keeps Save off until something changed, and undoes changes', async () => {
    const u = userEvent.setup();
    setup();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await u.click(screen.getByRole('button', { name: 'Move port 443 up' }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    await u.click(screen.getByRole('button', { name: 'Undo changes' }));
    expect(names()).toEqual(['Use WireGuard', 'Use port 443', 'Use AmneziaWG']);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('marks a method the gateway does not run', () => {
    setup({ available: ['wireguard', 'wireguard-wss'] });
    expect(screen.getByText(/The gateway is not running it now\./)).toBeInTheDocument();
  });

  it('refuses to save when the preview says devices would lose every way to connect', async () => {
    const u = userEvent.setup();
    const onPreview = vi.fn(async () => ({
      ...NO_PLAN,
      strands: [{ id: 'dev-1', name: 'Ada phone' }],
      strands_total: 1
    }));
    const { onSave } = setup({ onPreview });
    await u.click(screen.getByRole('button', { name: 'Move port 443 up' }));
    await u.click(screen.getByRole('button', { name: 'Save' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('1 device would have no way to connect');
    expect(alert).toHaveTextContent('Ada phone');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('asks before saving a change that makes devices download their profile again', async () => {
    const u = userEvent.setup();
    const onPreview = vi.fn(async () => ({
      ...NO_PLAN,
      reimport: [{ id: 'dev-2', name: 'Bruno laptop', access_method: 'amneziawg' as const }],
      reimport_total: 1
    }));
    const { onSave } = setup({ onPreview });
    await u.click(screen.getByRole('button', { name: 'Move port 443 up' }));
    await u.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('dialog', { name: '1 device must download its profile again' });
    expect(dialog).toHaveTextContent('Bruno laptop');
    expect(onSave).not.toHaveBeenCalled();
    await u.click(within(dialog).getByRole('button', { name: 'Save anyway' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  });

  it('shows the devices the server named when it refuses the save', async () => {
    const u = userEvent.setup();
    const onSave = vi.fn(async () => {
      throw new ApiError('refused', 409, 'would_strand_devices', {
        devices: [{ id: 'dev-3', name: 'Chiara tablet' }],
        total: 1
      });
    });
    setup({ onSave });
    await u.click(screen.getByRole('button', { name: 'Move port 443 up' }));
    await u.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Chiara tablet');
  });

  it('says when saving failed for another reason', async () => {
    const u = userEvent.setup();
    setup({
      onSave: vi.fn(async () => {
        throw new ApiError('boom', 500);
      })
    });
    await u.click(screen.getByRole('button', { name: 'Move port 443 up' }));
    await u.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The connection order was not saved. Try again.');
  });

  it('is read-only without the right to edit', () => {
    setup({ mayEdit: false, readOnlyNote: 'Only an administrator can change this.' });
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.getByText('Only an administrator can change this.')).toBeInTheDocument();
    for (const button of screen.getAllByRole('button', { name: /^Move / })) expect(button).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Force only the first' })).toBeDisabled();
  });

  it('speaks Italian', async () => {
    await setLanguage('it');
    setup({ inheritLabel: 'Eredita da linea Viaggiatori' });
    expect(screen.getByRole('radio', { name: 'Eredita da linea Viaggiatori' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Personalizzato' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Forza solo il primo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sposta porta 443 su' })).toBeInTheDocument();
  });
});
