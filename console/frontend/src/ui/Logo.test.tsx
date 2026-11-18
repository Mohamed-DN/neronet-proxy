import { act, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ALLACCIO_LIT_MS, Logo, SMALL_MARK_MAX_PX, logoPixels, type LogoHandle } from './Logo';

describe('Logo', () => {
  it('names the mark NeroNet when it stands alone', () => {
    render(<Logo />);
    expect(screen.getByRole('img', { name: 'NeroNet' })).toBeInTheDocument();
  });

  it('with the wordmark, the word is the name and the mark is hidden', () => {
    render(<Logo wordmark />);
    expect(screen.getByText('NeroNet')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('can be hidden from assistive technology', () => {
    const { container } = render(<Logo wordmark decorative />);
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });

  it('switches to the small variant at 24 px and below', () => {
    const { container, rerender } = render(<Logo size={SMALL_MARK_MAX_PX} />);
    const variant = () => container.querySelector('svg')?.getAttribute('data-logo-variant');
    expect(variant()).toBe('small');
    expect(container.querySelectorAll('circle')).toHaveLength(1);
    rerender(<Logo size={SMALL_MARK_MAX_PX + 1} />);
    expect(variant()).toBe('full');
    expect(container.querySelectorAll('circle')).toHaveLength(2);
  });

  it('maps the named sizes to pixels', () => {
    expect(logoPixels('sm')).toBeLessThanOrEqual(SMALL_MARK_MAX_PX);
    expect(logoPixels('md')).toBeGreaterThan(SMALL_MARK_MAX_PX);
    expect(logoPixels(33)).toBe(33);
  });
});

describe('Logo animate', () => {
  it('is the still mark by default', () => {
    const { container } = render(<Logo />);
    expect(container.querySelector('.allaccio')).toBeNull();
  });

  it('plays Allaccio and calls onDone once the lamp is lit, and can replay', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never);
    const onDone = vi.fn();
    const ref = createRef<LogoHandle>();
    const { container } = render(<Logo ref={ref} animate="allaccio" onDone={onDone} />);
    expect(container.querySelector('.allaccio .al-lamp')).not.toBeNull();
    expect(screen.getByRole('img', { name: 'NeroNet' })).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(ALLACCIO_LIT_MS + 10));
    expect(onDone).toHaveBeenCalledTimes(1);
    act(() => ref.current?.replay());
    act(() => void vi.advanceTimersByTime(ALLACCIO_LIT_MS + 10));
    expect(onDone).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('under reduced motion is done at once', () => {
    vi.stubGlobal('matchMedia', (() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as never);
    const onDone = vi.fn();
    render(<Logo animate="allaccio" onDone={onDone} />);
    expect(onDone).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
