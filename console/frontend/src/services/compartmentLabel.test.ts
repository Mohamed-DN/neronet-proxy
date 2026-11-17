import { describe, expect, it } from 'vitest';

import { DEFAULT_COMPARTMENT_NAME, compartmentLabel, isDefaultCompartment } from './compartmentLabel';

describe('compartmentLabel', () => {
  it('recognises the default sub-network by slug, or by the seeded name when there is no slug', () => {
    expect(isDefaultCompartment({ name: 'Anything', slug: 'default' })).toBe(true);
    expect(isDefaultCompartment({ name: DEFAULT_COMPARTMENT_NAME })).toBe(true);
    expect(isDefaultCompartment({ name: DEFAULT_COMPARTMENT_NAME, slug: 'lab' })).toBe(false);
    expect(isDefaultCompartment({ name: 'Lab', slug: 'lab' })).toBe(false);
  });

  it('swaps the default for the translated words and leaves an operator-chosen name alone', () => {
    expect(compartmentLabel({ name: DEFAULT_COMPARTMENT_NAME }, 'Sotto-rete principale')).toBe('Sotto-rete principale');
    expect(compartmentLabel({ name: 'Lab', slug: 'lab' }, 'Sotto-rete principale')).toBe('Lab');
    expect(compartmentLabel({ name: null }, 'x')).toBe('');
  });
});
