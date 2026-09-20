import { useState } from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Button } from './Button';
import { ConfirmDialog } from './ConfirmDialog';
import { Dialog } from './Dialog';
import { Input } from './Input';
import { expectNoAxeViolations, renderUI } from '../test/harness';

function DialogHarness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Button onClick={() => setOpen(true)}>Open the profile</Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Cryptographic profile"
        description="The enrolment token is shown once."
        footer={<Button onClick={() => setOpen(false)}>Done</Button>}
      >
        <Input aria-label="Node name" />
      </Dialog>
    </div>
  );
}

describe('Dialog', () => {
  it('moves focus into the dialog and returns it to the opener on close', async () => {
    const user = userEvent.setup();
    renderUI(<DialogHarness />);

    const opener = screen.getByRole('button', { name: 'Open the profile' });
    opener.focus();
    await user.keyboard('{Enter}');

    const dialog = await screen.findByRole('dialog', { name: 'Cryptographic profile' });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('keeps Tab inside the dialog while it is open', async () => {
    const user = userEvent.setup();
    renderUI(<DialogHarness />);

    await user.click(screen.getByRole('button', { name: 'Open the profile' }));
    const dialog = await screen.findByRole('dialog');

    // Enough tabs to leave any three-element trap if there were no trap at all.
    for (let i = 0; i < 8; i += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('is described by its description for a screen reader', async () => {
    const user = userEvent.setup();
    renderUI(<DialogHarness />);
    await user.click(screen.getByRole('button', { name: 'Open the profile' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAccessibleDescription('The enrolment token is shown once.');
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('has no axe violations in either theme', async () => {
    for (const theme of ['light', 'dark'] as const) {
      const user = userEvent.setup();
      const { unmount } = renderUI(<DialogHarness />, { theme });
      await user.click(screen.getByRole('button', { name: 'Open the profile' }));
      const dialog = await screen.findByRole('dialog');
      await expectNoAxeViolations(dialog, theme);
      unmount();
    }
  });
});

function ConfirmHarness({ onConfirm, phrase = 'relay-de' }: { onConfirm: () => void; phrase?: string }) {
  const [open, setOpen] = useState(true);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      tone="danger"
      title="Revoke relay-de"
      description="The node loses its key and has to enrol again."
      confirmPhrase={phrase}
      onConfirm={onConfirm}
    />
  );
}

describe('ConfirmDialog', () => {
  it('keeps the destructive action disabled until the phrase matches exactly', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    renderUI(<ConfirmHarness onConfirm={onConfirm} />);

    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(confirm).toBeDisabled();

    const input = screen.getByLabelText('Confirmation phrase');
    await user.type(input, 'relay-d');
    expect(confirm).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('The phrase does not match yet.');

    await user.type(input, 'e');
    expect(confirm).toBeEnabled();

    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('does not confirm on Enter from the phrase field', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    renderUI(<ConfirmHarness onConfirm={onConfirm} />);

    await user.type(screen.getByLabelText('Confirmation phrase'), 'relay-de{Enter}');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('forgets the typed phrase when it closes', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();

    function Reopenable() {
      const [open, setOpen] = useState(true);
      return (
        <div>
          <Button onClick={() => setOpen(true)}>Reopen</Button>
          <ConfirmDialog
            open={open}
            onOpenChange={setOpen}
            tone="danger"
            title="Revoke relay-de"
            description="The node loses its key."
            confirmPhrase="relay-de"
            onConfirm={onConfirm}
          />
        </div>
      );
    }
    renderUI(<Reopenable />);

    await user.type(screen.getByLabelText('Confirmation phrase'), 'relay-de');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Reopen' }));
    expect(await screen.findByLabelText('Confirmation phrase')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
  });

  it('has no axe violations in either theme', async () => {
    for (const theme of ['light', 'dark'] as const) {
      const { unmount } = renderUI(<ConfirmHarness onConfirm={() => {}} />, { theme });
      const dialog = await screen.findByRole('dialog');
      await expectNoAxeViolations(dialog, theme);
      unmount();
    }
  });
});
