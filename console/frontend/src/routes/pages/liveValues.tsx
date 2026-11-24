import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { formatRelativeTime } from '../../i18n/format';

/**
 * Values that age (ADR 0042): where a device is, and how fast it answered. Each one says
 * what it is, who or what produced it and how old it is, and never fills a gap with a
 * plausible number.
 */

/** The current time, re-read every `ms` while the tab is visible, so ages stay true. */
export function useNow(ms = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') setNow(Date.now());
    }, ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

/** The country name in the console's language, from a two-letter code. */
export function countryName(language: string, code: string): string {
  try {
    return new Intl.DisplayNames([language], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** User-assigned and exceptionally reserved region codes that are not countries. */
const RESERVED = /^(AA|Q[M-Z]|X[A-Z]|ZZ|AC|CP|DG|EA|EU|EZ|IC|TA|UN)$/;

/** Every two-letter code the browser can name, with its name, sorted for a select. */
export function countryOptions(language: string): { value: string; label: string }[] {
  const names = new Intl.DisplayNames([language], { type: 'region' });
  const unknownRegion = names.of('ZZ');
  const out: { value: string; label: string }[] = [];
  for (let a = 65; a <= 90; a += 1) {
    for (let b = 65; b <= 90; b += 1) {
      const code = String.fromCharCode(a, b);
      let name: string | undefined;
      try {
        name = names.of(code);
      } catch {
        name = undefined;
      }
      // Intl names reserved and exceptional codes too (ZZ is 'Unknown Region'); only real countries are offered.
      if (name && name !== code && name !== unknownRegion && !RESERVED.test(code))
        out.push({ value: code, label: name });
    }
  }
  return out.sort((x, y) => x.label.localeCompare(y.label, language));
}

interface LocationProps {
  countryCode?: string | null;
  source?: 'declared' | 'agent' | null;
  /** Show who stated it. The map and the table keep to the country. */
  withSource?: boolean;
}

/** A device's country, or "Location unknown". Never a default. */
export function LocationValue({ countryCode, source, withSource = false }: LocationProps) {
  const { t, i18n } = useTranslation('ui');
  if (!countryCode) return <span className="text-muted">{t('live.locationUnknown')}</span>;
  const name = countryName(i18n.language, countryCode);
  if (withSource && source === 'declared') return <>{t('live.locationDeclared', { country: name })}</>;
  if (withSource && source === 'agent') return <>{t('live.locationAgent', { country: name })}</>;
  return <>{name}</>;
}

interface ResponseProps {
  rttMs?: number | null;
  measuredAt?: string | null;
  /** The shared clock; omit to let the value keep its own. */
  now?: number;
}

/**
 * How a device answered the gateway's last ping: the time and its age; "no reply" with its
 * age; or "not measured". A missing reply is not a number and not "offline".
 */
export function ResponseValue({ rttMs, measuredAt, now }: ResponseProps) {
  const { t, i18n } = useTranslation('ui');
  const own = useNow();
  const clock = now ?? own;
  const when = useMemo(
    () => (measuredAt ? formatRelativeTime(i18n.language, measuredAt, new Date(clock)) : null),
    [i18n.language, measuredAt, clock]
  );
  if (!measuredAt || !when) return <span className="text-muted">{t('live.responseNotMeasured')}</span>;
  if (rttMs === null || rttMs === undefined)
    return <span className="text-muted">{t('live.responseNoReply', { when })}</span>;
  return <>{t('live.responseValue', { rtt: rttMs < 10 ? rttMs.toFixed(2) : rttMs.toFixed(1), when })}</>;
}
