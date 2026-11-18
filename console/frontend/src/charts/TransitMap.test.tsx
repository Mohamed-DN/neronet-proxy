import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TransitMap, type MapLine } from './TransitMap';

function stubMotion(reduce: boolean) {
  vi.stubGlobal('matchMedia', ((query: string) => ({
    matches: reduce && query.includes('reduce'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia);
}

const line = (service: boolean, heading = 'Main sub-network'): MapLine => ({
  key: 'l1',
  heading,
  detail: '2 devices',
  colour: 'blue',
  stations: [
    { id: 'a', label: 'Alpha', symbol: 'service', description: 'Alpha, in service' },
    {
      id: 'b',
      label: 'Beta',
      symbol: service ? 'service' : 'unmeasured',
      description: service ? 'Beta, in service' : 'Beta, not measured'
    }
  ]
});

const noop = () => {};

describe('TransitMap events', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stubMotion(false);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('plays nothing on the first render', () => {
    const { container } = render(<TransitMap lines={[line(false)]} onOpenStation={noop} label="map" />);
    expect(container.querySelector('.map-current')).toBeNull();
    expect(container.querySelector('[data-fx]')?.getAttribute('data-fx') ?? null).toBeNull();
  });

  it('runs a current and lights the lamp when a station comes into service, then stops', () => {
    const { container, rerender } = render(<TransitMap lines={[line(false)]} onOpenStation={noop} label="map" />);
    rerender(<TransitMap lines={[line(true)]} onOpenStation={noop} label="map" />);
    expect(container.querySelector('.map-current')).not.toBeNull();
    expect(container.querySelector('[data-station-id="b"] [data-fx="on"]')).not.toBeNull();
    expect(container.querySelector('[data-station-id="b"] .map-spark')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(container.querySelector('.map-current')).toBeNull();
    expect(container.querySelector('[data-fx]')).toBeNull();
  });

  it('dims, without a current or a spark, when a station leaves service', () => {
    const { container, rerender } = render(<TransitMap lines={[line(true)]} onOpenStation={noop} label="map" />);
    rerender(<TransitMap lines={[line(false)]} onOpenStation={noop} label="map" />);
    expect(container.querySelector('[data-station-id="b"] [data-fx="off"]')).not.toBeNull();
    expect(container.querySelector('.map-current')).toBeNull();
    expect(container.querySelector('.map-spark')).toBeNull();
  });

  it('does not animate under reduced motion, only updates the symbol', () => {
    stubMotion(true);
    const { container, rerender } = render(<TransitMap lines={[line(false)]} onOpenStation={noop} label="map" />);
    rerender(<TransitMap lines={[line(true)]} onOpenStation={noop} label="map" />);
    expect(container.querySelector('.map-current')).toBeNull();
    expect(container.querySelector('[data-fx]')).toBeNull();
    expect(container.querySelector('[data-station-id="b"] [data-station="service"]')).not.toBeNull();
  });

  it('plays at most six lamps at once and the rest wait', () => {
    const many = (service: boolean): MapLine => ({
      key: 'l1',
      heading: 'Many',
      colour: 'red',
      stations: Array.from({ length: 9 }, (_, i) => ({
        id: `s${i}`,
        label: `S${i}`,
        symbol: service ? ('service' as const) : ('unmeasured' as const),
        description: `s${i}`
      }))
    });
    const { container, rerender } = render(<TransitMap lines={[many(false)]} onOpenStation={noop} label="map" />);
    rerender(<TransitMap lines={[many(true)]} onOpenStation={noop} label="map" />);
    expect(container.querySelectorAll('[data-fx="on"]')).toHaveLength(6);
    act(() => {
      vi.advanceTimersByTime(960);
    });
    expect(container.querySelectorAll('[data-fx="on"]')).toHaveLength(3);
  });
});

describe('TransitMap live flow', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('moves only lines that have flow, and never when there is none', () => {
    stubMotion(false);
    const { container, rerender } = render(<TransitMap lines={[line(true)]} onOpenStation={noop} label="map" />);
    expect(container.querySelector('.map-flow')).toBeNull();
    rerender(
      <TransitMap
        lines={[line(true)]}
        flow={new Map([['l1', { pulses: 2, durationMs: 3000 }]])}
        onOpenStation={noop}
        label="map"
      />
    );
    expect(container.querySelectorAll('.map-flow')).toHaveLength(2);
    rerender(<TransitMap lines={[line(true)]} flow={new Map()} onOpenStation={noop} label="map" />);
    expect(container.querySelector('.map-flow')).toBeNull();
  });

  it('draws no flow under reduced motion', () => {
    stubMotion(true);
    const { container } = render(
      <TransitMap
        lines={[line(true)]}
        flow={new Map([['l1', { pulses: 3, durationMs: 2000 }]])}
        onOpenStation={noop}
        label="map"
      />
    );
    expect(container.querySelector('.map-flow')).toBeNull();
  });
});

describe('TransitMap line names', () => {
  it('lets a sub-network name take the room it needs, and names it in full on the heading', () => {
    stubMotion(false);
    const name = 'Main sub-network with a rather long name';
    const { container } = render(<TransitMap lines={[line(true, name)]} onOpenStation={noop} label="map" />);
    const heading = container.querySelector('p');
    expect(heading?.querySelector('[title]')?.getAttribute('title')).toBe(name);
    // The old fixed 190 px cap truncated "Main sub-ne…"; the cap is now what is free to the right.
    expect(parseFloat((heading as HTMLElement).style.maxWidth)).toBeGreaterThan(190);
    vi.unstubAllGlobals();
  });
});
