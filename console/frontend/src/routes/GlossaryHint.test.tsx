import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import en from '../i18n/locales/en/glossary.json';
import itGlossary from '../i18n/locales/it/glossary.json';
import { expectNoAxeViolations, renderUI } from '../test/harness';
import { GLOSSARY_TERM_IDS, GlossaryHint } from './GlossaryHint';

describe('GlossaryHint', () => {
  it('the term id list matches the terms in both glossary files', () => {
    expect([...GLOSSARY_TERM_IDS].sort()).toEqual(Object.keys(en.terms).sort());
    expect(Object.keys(itGlossary.terms).sort()).toEqual(Object.keys(en.terms).sort());
  });

  it('term prop names the trigger "More about Network address" and shows the body on focus', async () => {
    renderUI(<GlossaryHint term="overlayAddress" />);

    const trigger = screen.getByRole('button', { name: 'More about Network address' });
    await userEvent.tab();

    expect(trigger).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'The private address a device uses inside the network'
    );
  });

  it('keeps the text and label props working for callers that pass their own copy', async () => {
    renderUI(<GlossaryHint text="Explains the overlay address." label="More about overlay address" />);

    await userEvent.tab();

    expect(screen.getByRole('button', { name: 'More about overlay address' })).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Explains the overlay address.');
  });

  it('has a trigger of at least 24 by 24 pixels', () => {
    renderUI(<GlossaryHint term="device" />);

    const trigger = screen.getByRole('button', { name: 'More about Device' });
    expect(trigger.className).toContain('h-6');
    expect(trigger.className).toContain('w-6');
  });

  it('has no axe violations in light and dark themes', async () => {
    const light = renderUI(<GlossaryHint term="device" />, { theme: 'light' });
    await expectNoAxeViolations(light.container, 'light');
    light.unmount();

    const dark = renderUI(<GlossaryHint term="device" />, { theme: 'dark' });
    await expectNoAxeViolations(dark.container, 'dark');
  });
});
