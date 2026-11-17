import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { Segmented } from './Segmented';
import { expectAccessibleInBothThemes, renderUI } from '../test/harness';

const OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'up', label: 'In service' },
  { value: 'blocked', label: 'Blocked' }
] as const;

function Harness() {
  const [value, setValue] = useState<(typeof OPTIONS)[number]['value']>('all');
  return <Segmented label="Filter" value={value} onChange={setValue} options={[...OPTIONS]} />;
}

describe('Segmented', () => {
  it('is a radio group with one stop in the tab order', async () => {
    renderUI(<Harness />);
    expect(screen.getByRole('radiogroup', { name: 'Filter' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'All' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'All' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'Blocked' })).toHaveAttribute('tabindex', '-1');
  });

  it('moves the choice and focus with the arrow keys, wrapping at the ends', async () => {
    const user = userEvent.setup();
    renderUI(<Harness />);
    screen.getByRole('radio', { name: 'All' }).focus();

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'In service' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'In service' })).toHaveFocus();

    await user.keyboard('{End}');
    expect(screen.getByRole('radio', { name: 'Blocked' })).toBeChecked();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'All' })).toBeChecked();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('radio', { name: 'Blocked' })).toHaveFocus();
  });

  it('has no axe violations in either theme', async () => {
    await expectAccessibleInBothThemes(<Harness />);
  });
});
