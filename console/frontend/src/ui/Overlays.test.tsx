import { useState } from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { Button } from './Button';
import { Tabs } from './Tabs';
import { Tooltip } from './Tooltip';
import { useToast } from './Toast';
import { expectAccessibleInBothThemes, expectNoAxeViolations, renderUI } from '../test/harness';

const ITEMS = [
  { value: 'routes', label: 'Routes', content: <p>Route table</p> },
  { value: 'acls', label: 'ACLs', content: <p>Access rules</p> },
  { value: 'audit', label: 'Audit', content: <p>Audit log</p> }
];

function TabsHarness() {
  const [value, setValue] = useState('routes');
  return <Tabs label="Node detail" items={ITEMS} value={value} onValueChange={setValue} />;
}

describe('Tabs', () => {
  it('moves between tabs with the arrow keys and keeps one tab stop', async () => {
    const user = userEvent.setup();
    renderUI(
      <div>
        <Button>Before</Button>
        <TabsHarness />
        <Button>After</Button>
      </div>
    );

    await user.tab();
    await user.tab();
    expect(screen.getByRole('tab', { name: 'Routes' })).toHaveFocus();

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'ACLs' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'ACLs' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Access rules');

    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Audit' })).toHaveFocus();

    // One stop for the whole list: the next Tab leaves it.
    await user.tab();
    expect(screen.getByRole('tabpanel')).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
  });

  it('names the tab list', () => {
    renderUI(<TabsHarness />);
    expect(screen.getByRole('tablist', { name: 'Node detail' })).toBeInTheDocument();
  });

  it('has no axe violations in either theme', async () => {
    await expectAccessibleInBothThemes(<TabsHarness />);
  });
});

describe('Tooltip', () => {
  it('shows on keyboard focus, not only on hover', async () => {
    const user = userEvent.setup();
    renderUI(
      <Tooltip content="Measured over the last minute">
        <Button>Reachability</Button>
      </Tooltip>
    );

    await user.tab();
    expect(screen.getByRole('button', { name: /reachability/i })).toHaveFocus();
    await waitFor(() => expect(screen.getAllByText('Measured over the last minute').length).toBeGreaterThan(0));
  });

  it('has no axe violations in either theme', async () => {
    await expectAccessibleInBothThemes(
      <Tooltip content="Measured over the last minute">
        <Button>Reachability</Button>
      </Tooltip>
    );
  });
});

function ToastHarness() {
  const { notify } = useToast();
  return (
    <div>
      <Button onClick={() => notify('Access rules saved', { tone: 'success' })}>Save</Button>
      <Button onClick={() => notify('Revocation failed', { tone: 'danger' })}>Revoke</Button>
    </div>
  );
}

describe('Toast', () => {
  it('announces a confirmation politely and a failure assertively', async () => {
    const user = userEvent.setup();
    const { container } = renderUI(<ToastHarness />);

    await user.click(screen.getByRole('button', { name: 'Save' }));
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Access rules saved');
    expect(status.closest('[aria-live]')).toHaveAttribute('aria-live', 'polite');

    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Revocation failed');
    expect(alert.closest('[aria-live]')).toHaveAttribute('aria-live', 'assertive');

    await expectNoAxeViolations(container);
  });

  it('lets a failure be dismissed rather than timing out on its own', async () => {
    const user = userEvent.setup();
    renderUI(<ToastHarness />);

    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await screen.findByRole('alert');

    await user.click(screen.getAllByRole('button', { name: 'Close' })[0]!);
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});
