import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Button } from './Button';
import { PageHeader } from './PageHeader';
import { expectAccessibleInBothThemes, renderUI } from '../test/harness';

describe('PageHeader', () => {
  it('renders one h1, the description and the primary action after secondary actions', () => {
    renderUI(
      <PageHeader
        title="Devices"
        description="Every device registered on the network."
        actions={<Button>Export</Button>}
        primaryAction={<Button variant="primary">Add device</Button>}
      />
    );

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveClass('text-display', 'tracking-tight');
    expect(screen.getByText('Every device registered on the network.')).toBeInTheDocument();

    const secondary = screen.getByRole('button', { name: 'Export' });
    const primary = screen.getByRole('button', { name: 'Add device' });
    expect(secondary.compareDocumentPosition(primary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('has no axe violations in either theme', async () => {
    await expectAccessibleInBothThemes(
      <PageHeader
        title="Devices"
        description="Every device registered on the network."
        actions={<Button>Export</Button>}
        primaryAction={<Button variant="primary">Add device</Button>}
      />
    );
  });
});
