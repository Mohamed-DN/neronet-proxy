import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Button } from './Button';
import { BreadcrumbContext, PageHeader } from './PageHeader';
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
    expect(screen.getByRole('heading', { level: 1 })).toHaveClass('text-display');
    expect(screen.getByText('Every device registered on the network.')).toBeInTheDocument();

    const secondary = screen.getByRole('button', { name: 'Export' });
    const primary = screen.getByRole('button', { name: 'Add device' });
    expect(secondary.compareDocumentPosition(primary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('draws the breadcrumb the shell provides, with the current page marked', () => {
    renderUI(
      <BreadcrumbContext.Provider value={{ label: 'You are here', trail: ['Network', 'Map'] }}>
        <PageHeader title="Map" />
      </BreadcrumbContext.Provider>
    );

    const crumb = screen.getByRole('navigation', { name: 'You are here' });
    expect(crumb).toHaveTextContent('Network');
    expect(crumb).toHaveTextContent('Map');
    expect(screen.getByText('Map', { selector: '[aria-current="page"]' })).toBeInTheDocument();
  });

  it('draws no breadcrumb outside the shell, or for a page that sits at the top level', () => {
    const { rerender } = renderUI(<PageHeader title="Devices" />);
    expect(screen.queryByRole('navigation')).toBeNull();

    rerender(
      <BreadcrumbContext.Provider value={{ label: 'You are here', trail: ['Settings'] }}>
        <PageHeader title="Settings" />
      </BreadcrumbContext.Provider>
    );
    expect(screen.queryByRole('navigation')).toBeNull();
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
