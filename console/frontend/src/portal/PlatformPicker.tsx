import { useId } from 'react';
import { Check, Laptop, Monitor, Smartphone, Terminal, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../ui/cn';
import { PLATFORMS, type Platform } from './platform';

const ICONS: Record<Platform, LucideIcon> = {
  ios: Smartphone,
  android: Smartphone,
  windows: Monitor,
  macos: Laptop,
  linux: Terminal
};

export interface PlatformPickerProps {
  value: Platform | null;
  onChange: (platform: Platform) => void;
  /** The platform the browser says this device is, so it can be marked "this one". */
  detected: Platform | null;
}

/**
 * Big tiles, one per kind of device: the first question of adding one. A radio
 * group (arrow keys move between tiles); the chosen tile also shows a check, so
 * the choice never rests on its colour.
 */
export function PlatformPicker({ value, onChange, detected }: PlatformPickerProps) {
  const { t } = useTranslation('portal');
  const name = useId();
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {PLATFORMS.map((platform) => {
        const Icon = ICONS[platform];
        const checked = value === platform;
        return (
          <label key={platform} className="relative block">
            <input
              type="radio"
              name={name}
              value={platform}
              checked={checked}
              onChange={() => onChange(platform)}
              className="peer sr-only"
            />
            <span
              className={cn(
                'flex min-h-24 cursor-pointer flex-col items-start justify-between gap-2 rounded-card border bg-surface-raised p-3 text-content',
                'hover:bg-surface-hover peer-focus-visible:outline-focus',
                checked ? 'border-2 border-content' : 'border border-border-strong'
              )}
            >
              <span className="flex w-full items-start justify-between">
                <Icon aria-hidden="true" className="h-6 w-6" />
                {checked && <Check aria-hidden="true" className="h-5 w-5" />}
              </span>
              <span className="text-body font-medium">{t(`add.platform.${platform}`)}</span>
              {detected === platform && (
                <span className="-mt-1 text-caption text-muted">{t('add.platform.thisOne')}</span>
              )}
            </span>
          </label>
        );
      })}
    </div>
  );
}
