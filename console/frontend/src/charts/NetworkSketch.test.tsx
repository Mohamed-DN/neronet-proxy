import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations, renderUI } from '../test/harness';
import { NetworkSketch, type SketchSite } from './NetworkSketch';

function sites(count: number): SketchSite[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `s${i}`,
    label: `Site ${i}`,
    total: count - i,
    live: i % 2
  }));
}

const common = {
  title: 'Sub-networks',
  description: 'Each circle is a sub-network; hollow circles have no live device.',
  centerLabel: 'Network',
  moreLabel: (hidden: number) => `${hidden} more`,
  hollowLegend: 'Hollow: no live device'
};

describe('NetworkSketch', () => {
  it('shows at most maxSites sites and the more label for the rest', () => {
    const { container } = renderUI(<NetworkSketch {...common} sites={sites(14)} maxSites={12} />);

    // One circle for the centre and one per shown site.
    expect(container.querySelectorAll('circle')).toHaveLength(13);
    expect(screen.getByText('2 more')).toBeInTheDocument();
  });

  it('draws a site with no live device hollow and its line dashed', () => {
    const { container } = renderUI(
      <NetworkSketch
        {...common}
        sites={[
          { id: 'a', label: 'Alpha', total: 4, live: 0 },
          { id: 'b', label: 'Beta', total: 2, live: 1 }
        ]}
      />
    );

    const hollow = container.querySelector('[data-site="a"]');
    const solid = container.querySelector('[data-site="b"]');
    expect(hollow).toHaveAttribute('data-live', 'false');
    expect(solid).toHaveAttribute('data-live', 'true');
    expect(container.querySelector('[data-site-line="a"]')).toHaveAttribute('stroke-dasharray', '4 3');
    expect(container.querySelector('[data-site-line="b"]')).not.toHaveAttribute('stroke-dasharray');
  });

  it('labels the picture with its visible caption', () => {
    renderUI(<NetworkSketch {...common} sites={sites(2)} />);

    expect(screen.getByRole('img', { name: /Sub-networks/ })).toBeInTheDocument();
  });

  it('has no accessibility violations in light and dark', async () => {
    const element = <NetworkSketch {...common} sites={sites(5)} />;
    const light = renderUI(element, { theme: 'light' });
    await expectNoAxeViolations(light.container, 'light');
    light.unmount();

    const dark = renderUI(element, { theme: 'dark' });
    await expectNoAxeViolations(dark.container, 'dark');
  });
});
