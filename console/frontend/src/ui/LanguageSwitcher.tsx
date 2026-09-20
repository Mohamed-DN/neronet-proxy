import { useTranslation } from 'react-i18next';

import { cn } from './cn';
import { LANGUAGES, isLanguage, setLanguage, type Language } from '../i18n';

/**
 * Switches the interface language and, with it, `document.documentElement.lang`
 * so a screen reader changes voice. The choice is kept for the next session.
 *
 * A native select: it is one control in the tab order, it works on a phone, and
 * there is nothing here that a listbox would do better.
 */
export function LanguageSwitcher({ className }: { className?: string }) {
  const { t, i18n } = useTranslation('ui');
  const current = (isLanguage(i18n.language) ? i18n.language : 'en') as Language;

  return (
    <label className={cn('inline-flex items-center gap-2', className)}>
      <span className="sr-only">{t('language.label')}</span>
      <select
        value={current}
        onChange={(event) => {
          const next = event.target.value;
          if (isLanguage(next)) void setLanguage(next);
        }}
        className={cn(
          'h-7 rounded-control border border-border bg-surface-sunken px-2 text-caption text-content',
          'focus-visible:outline-focus'
        )}
      >
        {LANGUAGES.map((language) => (
          <option key={language} value={language}>
            {t(`language.${language}`)}
          </option>
        ))}
      </select>
    </label>
  );
}
