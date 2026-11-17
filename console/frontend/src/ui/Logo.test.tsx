import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Logo, SMALL_MARK_MAX_PX, logoPixels } from './Logo';

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
