import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from './cn';
import { useTheme } from '../theme/ThemeProvider';
import type { ThemePreference } from './tokens';

const OPTIONS: Array<{ value: ThemePreference; icon: LucideIcon; key: string }> = [
  { value: 'light', icon: Sun, key: 'theme.light' },
  { value: 'dark', icon: Moon, key: 'theme.dark' },
  { value: 'system', icon: Monitor, key: 'theme.system' }
];

/**
 * Light, dark, or whatever the operating system says. A radio group rather than
 * a two-state toggle, because "follow the system" is a third choice and not the
 * absence of one.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { t } = useTranslation('ui');
  const { preference, setPreference } = useTheme();

  return (
    <div
      role="radiogroup"
      aria-label={t('theme.label')}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-control border border-border bg-surface-sunken p-0.5',
        className
      )}
    >
      {OPTIONS.map(({ value, icon: Icon, key }) => {
        const active = preference === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={t(key)}
            onClick={() => setPreference(value)}
            className={cn(
              'inline-flex h-6 w-7 items-center justify-center rounded-sm transition-colors focus-visible:outline-focus',
              active ? 'bg-surface-raised text-accent shadow-raised' : 'text-muted hover:text-content'
            )}
          >
            <Icon aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        );
      })}
    </div>
  );
}
