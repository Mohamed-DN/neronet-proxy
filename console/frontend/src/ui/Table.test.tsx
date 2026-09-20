import { useState } from 'react';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { NotMeasured } from './States';
import { Table, sortRows, type SortState, type TableColumn } from './Table';
import { expectAccessibleInBothThemes, renderUI } from '../test/harness';

interface Node {
  id: string;
  name: string;
  risk: number | null;
}

const NODES: Node[] = [
  { id: 'n1', name: 'relay-de', risk: 12 },
  { id: 'n2', name: 'relay-fr', risk: null },
  { id: 'n3', name: 'client-es', risk: 78 }
];

const columns: Array<TableColumn<Node>> = [
  { id: 'name', header: 'Name', cell: (row) => row.name, sortable: true },
  {
    id: 'risk',
    header: 'Risk',
    numeric: true,
    sortable: true,
    cell: (row) => (row.risk === null ? <NotMeasured /> : row.risk)
  }
];

function SortableTable({ onSortChange }: { onSortChange?: (sort: SortState) => void }) {
  const [sort, setSort] = useState<SortState | null>(null);
  const rows = sort
    ? sortRows(NODES, (row) => (sort.columnId === 'name' ? row.name : row.risk), sort.direction)
    : NODES;
  return (
    <Table
      caption="Enrolled nodes"
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      sort={sort}
      onSortChange={(next) => {
        setSort(next);
        onSortChange?.(next);
      }}
    />
  );
}

describe('Table', () => {
  it('names itself and its columns', () => {
    renderUI(<SortableTable />);
    expect(screen.getByRole('table', { name: /enrolled nodes/i })).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader')).toHaveLength(2);
  });

  it('sorts from the keyboard and reports the direction through aria-sort', async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    renderUI(<SortableTable onSortChange={onSortChange} />);

    const nameHeader = screen.getByRole('columnheader', { name: /name/i });
    expect(nameHeader).toHaveAttribute('aria-sort', 'none');

    await user.tab();
    expect(within(nameHeader).getByRole('button')).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(onSortChange).toHaveBeenLastCalledWith({ columnId: 'name', direction: 'asc' });
    expect(screen.getByRole('columnheader', { name: /name/i })).toHaveAttribute('aria-sort', 'ascending');

    await user.keyboard('{Enter}');
    expect(onSortChange).toHaveBeenLastCalledWith({ columnId: 'name', direction: 'desc' });
    expect(screen.getByRole('columnheader', { name: /name/i })).toHaveAttribute('aria-sort', 'descending');
  });

  it('actually reorders the rows', async () => {
    const user = userEvent.setup();
    renderUI(<SortableTable />);

    await user.click(within(screen.getByRole('columnheader', { name: /name/i })).getByRole('button'));
    const names = screen
      .getAllByRole('row')
      .slice(1)
      .map((row) => (row as HTMLTableRowElement).cells[0]?.textContent);
    expect(names).toEqual(['client-es', 'relay-de', 'relay-fr']);
  });

  it('keeps rows that were never measured at the end of both sort directions', () => {
    const ascending = sortRows(NODES, (row) => row.risk, 'asc').map((row) => row.id);
    const descending = sortRows(NODES, (row) => row.risk, 'desc').map((row) => row.id);
    expect(ascending).toEqual(['n1', 'n3', 'n2']);
    expect(descending).toEqual(['n3', 'n1', 'n2']);
  });

  it('renders a missing value as Not measured rather than zero', () => {
    renderUI(<SortableTable />);
    expect(screen.getByText('Not measured')).toBeInTheDocument();
  });

  it('selects rows from the keyboard and reports the count', async () => {
    const user = userEvent.setup();

    function Selectable() {
      const [selected, setSelected] = useState<string[]>([]);
      return (
        <Table
          caption="Enrolled nodes"
          showCaption
          columns={columns}
          rows={NODES}
          rowKey={(row) => row.id}
          selectedKeys={selected}
          onSelectionChange={setSelected}
        />
      );
    }
    renderUI(<Selectable />);

    await user.click(screen.getByRole('checkbox', { name: /select row: n1/i }));
    expect(screen.getByText('1 row selected')).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Select all rows' }));
    expect(screen.getByText('3 rows selected')).toBeInTheDocument();
  });

  it('shows the empty state instead of an empty grid', () => {
    renderUI(<Table caption="Enrolled nodes" columns={columns} rows={[]} rowKey={(row) => row.id} />);
    expect(screen.getByText('Nothing to show')).toBeInTheDocument();
  });

  it('shows the error state with the real failure and a retry', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    renderUI(
      <Table
        caption="Enrolled nodes"
        columns={columns}
        rows={[]}
        rowKey={(row) => row.id}
        error="502 from the control plane"
        onRetry={onRetry}
      />
    );

    expect(screen.getByRole('alert')).toHaveTextContent('502 from the control plane');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('announces that it is loading', () => {
    renderUI(<Table caption="Enrolled nodes" columns={columns} rows={[]} rowKey={(row) => row.id} loading />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
  });

  it('has no axe violations in either theme, at either density', async () => {
    await expectAccessibleInBothThemes(
      <Table
        caption="Enrolled nodes"
        columns={columns}
        rows={NODES}
        rowKey={(row) => row.id}
        density="compact"
        sort={{ columnId: 'name', direction: 'asc' }}
        onSortChange={() => {}}
        selectedKeys={['n1']}
        onSelectionChange={() => {}}
      />
    );
  });
});
