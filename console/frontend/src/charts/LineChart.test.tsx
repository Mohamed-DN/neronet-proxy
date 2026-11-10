import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations, renderUI } from '../test/harness';
import { LineChart } from './LineChart';

const labels = ['Mon', 'Tue', 'Wed'];

describe('LineChart', () => {
  it('keeps every value, and a dash for each gap, in a hidden table', () => {
    renderUI(
      <LineChart
        title="Latency"
        labels={labels}
        unit="ms"
        series={[{ id: 'lat', label: 'Latency', values: [10, null, 30], tone: 'chart-1' }]}
      />
    );

    const table = screen.getByRole('table', { name: 'Latency' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(4);
    expect(within(rows[2] as HTMLElement).getByRole('cell', { name: '—' })).toBeInTheDocument();
    expect(within(rows[3] as HTMLElement).getByRole('cell', { name: '30' })).toBeInTheDocument();
  });

  it('draws in real pixels with fixed-size text, so the viewBox never scales it', () => {
    const { container } = renderUI(
      <LineChart
        title="Latency"
        labels={labels}
        unit="ms"
        series={[{ id: 'lat', label: 'Latency', values: [10, null, 30], tone: 'chart-1' }]}
      />
    );

    const svg = container.querySelector('svg') as SVGSVGElement;
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${svg.getAttribute('width')} ${svg.getAttribute('height')}`);
    const texts = Array.from(svg.querySelectorAll('text'));
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) expect(text.style.fontSize).toBe('12px');
  });

  it('splits the path at a gap instead of drawing zero', () => {
    const { container } = renderUI(
      <LineChart
        title="Latency"
        labels={labels}
        unit="ms"
        series={[{ id: 'lat', label: 'Latency', values: [10, null, 30], tone: 'chart-1' }]}
      />
    );

    const line = container.querySelector('path[data-series="lat"]');
    expect(line).not.toBeNull();
    const d = line?.getAttribute('d') ?? '';
    expect(d.match(/M/g)).toHaveLength(2);
  });

  it('has no accessibility violations in light and dark', async () => {
    const element = (
      <LineChart
        title="Latency"
        labels={labels}
        unit="ms"
        series={[{ id: 'lat', label: 'Latency', values: [10, null, 30], tone: 'chart-1' }]}
      />
    );
    const light = renderUI(element, { theme: 'light' });
    await expectNoAxeViolations(light.container, 'light');
    light.unmount();

    const dark = renderUI(element, { theme: 'dark' });
    await expectNoAxeViolations(dark.container, 'dark');
  });
});
