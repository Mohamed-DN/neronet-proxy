import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { stubLayout } from '../test/layout';
import { useLayoutSize } from './useLayoutSize';

function Probe() {
  return <p data-testid="size">{useLayoutSize()}</p>;
}

afterEach(() => vi.unstubAllGlobals());

describe('useLayoutSize', () => {
  it.each(['desktop', 'tablet', 'phone'] as const)('answers %s when the window is that size', (size) => {
    stubLayout(size);
    render(<Probe />);
    expect(screen.getByTestId('size')).toHaveTextContent(size);
  });

  it('follows the window when it is resized or the device is turned', () => {
    const turnTo = stubLayout('phone');
    render(<Probe />);
    expect(screen.getByTestId('size')).toHaveTextContent('phone');

    act(() => turnTo('tablet'));
    expect(screen.getByTestId('size')).toHaveTextContent('tablet');

    act(() => turnTo('desktop'));
    expect(screen.getByTestId('size')).toHaveTextContent('desktop');
  });

  it('draws the desktop layout when the environment has no matchMedia', () => {
    vi.stubGlobal('matchMedia', undefined);
    render(<Probe />);
    expect(screen.getByTestId('size')).toHaveTextContent('desktop');
  });

  it('draws the desktop layout when every query answers no, as the default test stub does', () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {}
    }));
    render(<Probe />);
    expect(screen.getByTestId('size')).toHaveTextContent('desktop');
  });

  it('falls back to addListener on a browser without addEventListener on MediaQueryList', () => {
    const added: string[] = [];
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addListener: () => added.push(query),
      removeListener: () => {}
    }));
    render(<Probe />);
    expect(added).toHaveLength(2);
  });
});
