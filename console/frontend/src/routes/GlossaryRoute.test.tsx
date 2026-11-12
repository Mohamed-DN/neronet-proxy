import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

import en from '../i18n/locales/en/glossary.json';
import { setLanguage } from '../i18n';
import { expectNoAxeViolations, renderUI } from '../test/harness';
import GlossaryRoute from './GlossaryRoute';

const TERM_COUNT = Object.keys(en.terms).length;

function renderGlossary(theme: 'light' | 'dark' = 'light') {
  return renderUI(
    <MemoryRouter initialEntries={['/help/glossary']}>
      <GlossaryRoute />
    </MemoryRouter>,
    { theme }
  );
}

describe('GlossaryRoute', () => {
  afterEach(async () => {
    await setLanguage('en');
  });

  it('lists every term id as a dt', () => {
    const { container } = renderGlossary();

    const terms = container.querySelectorAll('dt');
    expect(terms).toHaveLength(TERM_COUNT);
    expect(container.querySelector('#term-overlayAddress')?.tagName).toBe('DT');
  });

  it('search filters to matching terms and Clear filters restores all', async () => {
    const { container } = renderGlossary();
    const search = screen.getByRole('searchbox', { name: 'Search the glossary' });

    await userEvent.type(search, 'relay');
    const filtered = container.querySelectorAll('dt');
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.length).toBeLessThan(TERM_COUNT);
    for (const dt of filtered) {
      expect(dt.textContent?.toLowerCase() + ' ' + dt.nextElementSibling?.textContent?.toLowerCase()).toContain(
        'relay'
      );
    }

    await userEvent.clear(search);
    await userEvent.type(search, 'zzzz-no-such-term');
    expect(container.querySelectorAll('dt')).toHaveLength(0);

    const empty = screen.getByText('Nothing matches these filters').closest('div') as HTMLElement;
    await userEvent.click(within(empty).getByRole('button', { name: 'Clear filters' }));

    expect(container.querySelectorAll('dt')).toHaveLength(TERM_COUNT);
  });

  it('renders the Italian page title "Glossario"', async () => {
    await setLanguage('it');
    renderGlossary();

    expect(screen.getByRole('heading', { level: 1, name: 'Glossario' })).toBeInTheDocument();
  });

  it('has no axe violations in light and dark themes', async () => {
    const light = renderGlossary('light');
    await expectNoAxeViolations(light.container, 'light');
    light.unmount();

    const dark = renderGlossary('dark');
    await expectNoAxeViolations(dark.container, 'dark');
  });
});
