import { useState } from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Checkbox } from './Checkbox';
import { FormField } from './FormField';
import { Input } from './Input';
import { Select } from './Select';
import { Switch } from './Switch';
import { expectAccessibleInBothThemes, renderUI } from '../test/harness';

describe('FormField', () => {
  it('wires the label, the hint and the error to the control', () => {
    renderUI(
      <FormField label="Overlay address" hint="Inside 100.64.0.0/10" error="Outside the assigned range" required>
        <Input defaultValue="10.0.0.1" />
      </FormField>
    );

    const input = screen.getByLabelText(/overlay address/i);
    expect(input).toBeRequired();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(/inside 100\.64\.0\.0\/10.*outside the assigned range/is);
    expect(screen.getByRole('alert')).toHaveTextContent('Outside the assigned range');
  });

  it('does not mark the control invalid when there is no error', () => {
    renderUI(
      <FormField label="Node name" hint="Shown in the fleet list">
        <Input />
      </FormField>
    );
    const input = screen.getByLabelText('Node name');
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input).toHaveAccessibleDescription('Shown in the fleet list');
  });

  it('has no axe violations in either theme', async () => {
    await expectAccessibleInBothThemes(
      <FormField label="Node name" hint="Shown in the fleet list" error="Already taken">
        <Input defaultValue="relay-de" />
      </FormField>
    );
  });
});

describe('Checkbox', () => {
  it('toggles with the space bar and exposes the mixed state', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderUI(
      <div>
        <Checkbox label="Quarantine the node" onChange={onChange} />
        <Checkbox aria-label="Select all rows" indeterminate checked={false} onChange={() => {}} />
      </div>
    );

    await user.tab();
    expect(screen.getByRole('checkbox', { name: 'Quarantine the node' })).toHaveFocus();
    await user.keyboard(' ');
    expect(onChange).toHaveBeenCalledOnce();

    expect(screen.getByRole('checkbox', { name: 'Select all rows' })).toHaveAttribute('aria-checked', 'mixed');
  });

  it('has no axe violations in either theme', async () => {
    await expectAccessibleInBothThemes(<Checkbox label="Quarantine the node" defaultChecked />);
  });
});

describe('Switch', () => {
  it('has the switch role and flips from the keyboard', async () => {
    const user = userEvent.setup();

    function Harness() {
      const [on, setOn] = useState(false);
      return <Switch checked={on} onCheckedChange={setOn} label="Onion routing" />;
    }
    renderUI(<Harness />);

    const control = screen.getByRole('switch', { name: 'Onion routing' });
    expect(control).toHaveAttribute('aria-checked', 'false');

    await user.tab();
    expect(control).toHaveFocus();
    await user.keyboard(' ');
    expect(control).toHaveAttribute('aria-checked', 'true');

    await user.keyboard('{Enter}');
    expect(control).toHaveAttribute('aria-checked', 'false');
  });

  it('has no axe violations in either theme', async () => {
    await expectAccessibleInBothThemes(
      <Switch checked onCheckedChange={() => {}} label="Onion routing" description="Three-hop circuits" />
    );
  });
});

describe('Select', () => {
  it('opens, moves and commits with the keyboard only', async () => {
    const user = userEvent.setup();

    function Harness() {
      const [value, setValue] = useState('shadow-tls');
      return (
        <Select
          label="Obfuscation protocol"
          value={value}
          onValueChange={setValue}
          options={[
            { value: 'shadow-tls', label: 'ShadowTLS v3' },
            { value: 'vless-reality', label: 'VLESS Reality' },
            { value: 'quic-masque', label: 'QUIC MASQUE' }
          ]}
        />
      );
    }
    renderUI(<Harness />);

    const trigger = screen.getByRole('combobox', { name: 'Obfuscation protocol' });
    expect(trigger).toHaveTextContent('ShadowTLS v3');

    await user.tab();
    expect(trigger).toHaveFocus();

    await user.keyboard('{Enter}');
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getAllByRole('option')).toHaveLength(3);

    await user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(trigger).toHaveTextContent('VLESS Reality'));
  });

  it('closes on Escape without changing the value', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderUI(
      <Select
        label="Obfuscation protocol"
        value="shadow-tls"
        onValueChange={onValueChange}
        options={[
          { value: 'shadow-tls', label: 'ShadowTLS v3' },
          { value: 'vless-reality', label: 'VLESS Reality' }
        ]}
      />
    );

    const trigger = screen.getByRole('combobox', { name: 'Obfuscation protocol' });
    trigger.focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('listbox');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    expect(onValueChange).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
  });

  it('has no axe violations in either theme', async () => {
    await expectAccessibleInBothThemes(
      <Select
        label="Obfuscation protocol"
        value="shadow-tls"
        onValueChange={() => {}}
        options={[{ value: 'shadow-tls', label: 'ShadowTLS v3' }]}
      />
    );
  });
});
