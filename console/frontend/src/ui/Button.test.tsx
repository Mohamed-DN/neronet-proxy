import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Trash2 } from 'lucide-react';

import { Button } from './Button';
import { IconButton } from './IconButton';
import { expectAccessibleInBothThemes, renderUI } from '../test/harness';

describe('Button', () => {
  it('is reachable and activated from the keyboard alone', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderUI(<Button onClick={onClick}>Revoke node</Button>);

    await user.tab();
    expect(screen.getByRole('button', { name: 'Revoke node' })).toHaveFocus();

    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('reports the busy state and refuses activation while loading', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderUI(
      <Button loading loadingLabel="Revoking" onClick={onClick}>
        Revoke node
      </Button>
    );

    const button = screen.getByRole('button', { name: /revoke node/i });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Revoking');

    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('defaults to type button so it cannot submit a form by accident', () => {
    renderUI(<Button>Close</Button>);
    expect(screen.getByRole('button', { name: 'Close' })).toHaveAttribute('type', 'button');
  });

  it('has no axe violations in either theme', async () => {
    await expectAccessibleInBothThemes(
      <div>
        <Button variant="primary">Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="danger">Danger</Button>
        <Button variant="ghost" disabled>
          Disabled
        </Button>
      </div>
    );
  });
});

describe('IconButton', () => {
  it('takes its accessible name from the label, not from a title attribute', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderUI(<IconButton icon={Trash2} label="Delete the access rule" onClick={onClick} />);

    const button = screen.getByRole('button', { name: 'Delete the access rule' });
    await user.tab();
    expect(button).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('has no axe violations in either theme', async () => {
    await expectAccessibleInBothThemes(<IconButton icon={Trash2} label="Delete" />);
  });
});
