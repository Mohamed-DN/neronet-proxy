import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Button } from './Button';
import { Row, RowList } from './RowList';
import { expectAccessibleInBothThemes, renderUI } from '../test/harness';

describe('RowList', () => {
  it('renders a labelled list with one listitem per Row', () => {
    renderUI(
      <RowList label="Devices">
        <Row title="laptop-ana" meta="100.64.0.12" />
        <Row title="gw-rome" meta="100.64.0.2" />
      </RowList>
    );

    const list = screen.getByRole('list', { name: 'Devices' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });

  it('onSelect makes the title a button and leaves actions separate', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onBlock = vi.fn();
    renderUI(
      <RowList label="Devices">
        <Row
          title="laptop-ana"
          onSelect={onSelect}
          actions={
            <Button size="sm" onClick={onBlock}>
              Block
            </Button>
          }
        />
      </RowList>
    );

    await user.click(screen.getByRole('button', { name: 'laptop-ana' }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onBlock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Block' }));
    expect(onBlock).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('has no axe violations in either theme', async () => {
    await expectAccessibleInBothThemes(
      <RowList label="Devices">
        <Row title="laptop-ana" meta="100.64.0.12" status={<span>Answering</span>} onSelect={() => {}} />
        <Row title="gw-rome" meta="100.64.0.2" actions={<Button size="sm">Block</Button>} />
      </RowList>
    );
  });
});
