import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { SkipLink } from '../ui/SkipLink';
import { ThemeToggle } from '../ui/ThemeToggle';
import { THEME_STORAGE_KEY } from '../ui/tokens';
import { expectAccessibleInBothThemes, renderUI } from '../test/harness';

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('ThemeToggle', () => {
  it('switches the document theme and keeps the choice', async () => {
    const user = userEvent.setup();
    renderUI(<ThemeToggle />, { theme: 'light' });

    await user.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    await user.click(screen.getByRole('radio', { name: 'Light' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('offers following the system as a third choice, not as the absence of one', async () => {
    const user = userEvent.setup();
    renderUI(<ThemeToggle />);

    const group = screen.getByRole('radiogroup', { name: 'Theme' });
    expect(group).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(3);

    await user.click(screen.getByRole('radio', { name: 'System' }));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('system');
    expect(screen.getByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'true');
  });

  it('is operable from the keyboard', async () => {
    const user = userEvent.setup();
    renderUI(<ThemeToggle />);

    await user.tab();
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('has no axe violations in either theme', async () => {
    await expectAccessibleInBothThemes(<ThemeToggle />);
  });
});

describe('SkipLink', () => {
  it('is the first thing a keyboard reaches and points at the main landmark', async () => {
    const user = userEvent.setup();
    renderUI(
      <div>
        <SkipLink />
        <button type="button">Sidebar entry</button>
        <main id="main-content" tabIndex={-1}>
          Content
        </main>
      </div>
    );

    await user.tab();
    const link = screen.getByRole('link', { name: 'Skip to content' });
    expect(link).toHaveFocus();
    expect(link).toHaveAttribute('href', '#main-content');
  });

  it('has no axe violations in either theme', async () => {
    await expectAccessibleInBothThemes(
      <div>
        <SkipLink />
        <main id="main-content" tabIndex={-1}>
          Content
        </main>
      </div>
    );
  });
});
