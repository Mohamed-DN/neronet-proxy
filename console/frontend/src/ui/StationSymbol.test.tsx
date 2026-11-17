import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { STATION_KINDS, StationStatus, StationSymbol } from './StationSymbol';
import { expectAccessibleInBothThemes, renderUI } from '../test/harness';

/** A reduced description of what is drawn, so two symbols with the same one would look the same. */
function silhouette(svg: SVGElement): string {
  return [...svg.children]
    .map((child) =>
      [
        child.tagName,
        child.getAttribute('r') ?? child.getAttribute('width') ?? '',
        child.getAttribute('stroke-dasharray') ?? '',
        child.getAttribute('fill') ?? ''
      ].join(':')
    )
    .join('|');
}

describe('StationSymbol', () => {
  it('draws a different shape for every kind, so none relies on colour', () => {
    const { container } = renderUI(
      <div>
        {STATION_KINDS.map((kind) => (
          <StationSymbol key={kind} kind={kind} />
        ))}
      </div>
    );
    const shapes = [...container.querySelectorAll<SVGElement>('svg[data-station]')].map(silhouette);
    expect(shapes).toHaveLength(6);
    expect(new Set(shapes).size).toBe(6);
  });

  it('is decorative unless it is given a label', () => {
    const { container, rerender } = renderUI(<StationSymbol kind="blocked" />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    rerender(<StationSymbol kind="blocked" label="Blocked" />);
    expect(screen.getByRole('img', { name: 'Blocked' })).toBeInTheDocument();
  });

  it('a status always carries its word beside the symbol', async () => {
    renderUI(<StationStatus kind="interrupted">Interrupted</StationStatus>);
    expect(screen.getByText('Interrupted')).toBeVisible();
    await expectAccessibleInBothThemes(
      <div>
        {STATION_KINDS.map((kind) => (
          <StationStatus key={kind} kind={kind}>
            {kind}
          </StationStatus>
        ))}
      </div>
    );
  });
});
