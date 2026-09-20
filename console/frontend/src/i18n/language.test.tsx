import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import i18n, { detectLanguage, setLanguage } from './index';
import { LanguageSwitcher } from '../ui/LanguageSwitcher';
import { StatusBadge } from '../ui/StatusBadge';
import { Stat } from '../ui/Stat';
import { LANGUAGE_STORAGE_KEY } from '../ui/tokens';
import { expectAccessibleInBothThemes, renderUI } from '../test/harness';

afterEach(async () => {
  window.localStorage.clear();
  await i18n.changeLanguage('en');
});

describe('language switching', () => {
  it('changes the chrome strings and the document language', async () => {
    const user = userEvent.setup();
    renderUI(
      <div>
        <LanguageSwitcher />
        <StatusBadge status="critical" />
        <Stat label="Circuits" value={null} />
      </div>
    );

    expect(screen.getByText('Critical')).toBeInTheDocument();
    expect(screen.getByText('Not measured')).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('en');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'it');

    await waitFor(() => expect(screen.getByText('Critico')).toBeInTheDocument());
    expect(screen.getByText('Non misurato')).toBeInTheDocument();
    expect(screen.queryByText('Critical')).not.toBeInTheDocument();
    await waitFor(() => expect(document.documentElement.lang).toBe('it'));
  });

  it('keeps the choice for the next session', async () => {
    const user = userEvent.setup();
    renderUI(<LanguageSwitcher />);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'it');
    await waitFor(() => expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('it'));
    expect(detectLanguage()).toBe('it');
  });

  it('falls back to English for a language the console does not speak', async () => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, 'de');
    expect(detectLanguage()).toBe('en');
  });

  it('formats through the active language', async () => {
    await setLanguage('it');
    renderUI(<Stat label="Nodi" value={new Intl.NumberFormat('it').format(1234567.5)} />);
    expect(screen.getByText('1.234.567,5')).toBeInTheDocument();
  });

  it('has no axe violations in either theme', async () => {
    await expectAccessibleInBothThemes(<LanguageSwitcher />);
  });
});
