import { useId } from 'react';
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { AccessMethod } from '../devices/wgConfig';
import { cn } from '../ui/cn';

/** The protocol name, shown muted beside the plain words: the person chooses by situation. */
const PROTOCOL: Record<AccessMethod, string> = {
  wireguard: 'WireGuard',
  'wireguard-wss': 'WireGuard + WebSocket',
  amneziawg: 'AmneziaWG'
};

export interface AccessMethodPickerProps {
  methods: AccessMethod[];
  value: AccessMethod;
  onChange: (method: AccessMethod) => void;
}

/**
 * How the device reaches the network, in words about the situation. A radio group like the
 * platform tiles; the chosen row also shows a check, so the choice never rests on colour.
 * The caller shows it only when there is more than one way to choose from.
 */
export function AccessMethodPicker({ methods, value, onChange }: AccessMethodPickerProps) {
  const { t } = useTranslation('portal');
  const name = useId();
  return (
    <div className="space-y-3">
      {methods.map((method) => {
        const checked = value === method;
        return (
          <label key={method} className="relative block">
            <input
              type="radio"
              name={name}
              value={method}
              checked={checked}
              onChange={() => onChange(method)}
              className="peer sr-only"
            />
            <span
              className={cn(
                'flex cursor-pointer items-start justify-between gap-3 rounded-card border bg-surface-raised p-3 text-content',
                'hover:bg-surface-hover peer-focus-visible:outline-focus',
                checked ? 'border-2 border-content' : 'border border-border-strong'
              )}
            >
              <span className="block">
                <span className="block text-body font-medium">
                  {t(`add.method.${method}.title`)}
                  <span className="ms-2 text-caption font-normal text-muted">{PROTOCOL[method]}</span>
                </span>
                <span className="mt-1 block text-body text-muted">{t(`add.method.${method}.body`)}</span>
              </span>
              {checked && <Check aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" />}
            </span>
          </label>
        );
      })}
    </div>
  );
}
