import { describe, expect, it } from 'vitest';

import { cn } from './cn';

describe('semantic class merging', () => {
  it.each(['micro', 'caption', 'label', 'body', 'heading', 'title', 'display', 'metric'])(
    'treats text-%s as a size independently of foreground color',
    (size) => {
      expect(cn('text-accent-contrast', `text-${size}`)).toBe(`text-accent-contrast text-${size}`);
      expect(cn(`text-${size}`, 'text-danger-contrast')).toBe(`text-${size} text-danger-contrast`);
    }
  );

  it('allows callers to replace size, color and spacing independently', () => {
    expect(cn('px-3 text-caption text-accent-contrast', 'px-6 text-body text-danger-contrast')).toBe(
      'px-6 text-body text-danger-contrast'
    );
  });
});
