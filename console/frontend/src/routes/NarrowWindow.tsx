import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { MonitorX } from 'lucide-react';

import { ROUTES } from './paths';

const MIN_WIDTH_PX = 1024;
const QUERY = `(min-width: ${MIN_WIDTH_PX}px)`;

/**
 * The console is a desktop tool.
 *
 * Its tables carry a dozen columns and the topology needs a canvas; below 1024
 * pixels they do not degrade into something an operator can work from, they
 * degrade into something that looks usable and is not. Saying so is the honest
 * option until a work package designs a narrow layout worth having.
 */
export function useIsWideEnough(): boolean {
  const [wide, setWide] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
    return window.matchMedia(QUERY).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(QUERY);
    const update = () => setWide(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  return wide;
}

/**
 * Shown instead of the whole shell below 1024 px: no sidebar, no top bar, so
 * nothing can overlap the message. The way forward is the personal portal,
 * which is built for a phone.
 */
export function NarrowWindow() {
  const { t } = useTranslation('chrome');

  return (
    <main
      data-narrow-window
      className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-surface px-6 py-12 text-center font-sans text-content"
    >
      <MonitorX aria-hidden="true" className="h-8 w-8 text-muted" />
      <h1 className="text-title font-semibold text-content">{t('narrow.title')}</h1>
      <p className="max-w-prose text-body text-subtle">{t('narrow.body')}</p>
      <Link
        to={ROUTES.me}
        className="inline-flex min-h-11 items-center justify-center rounded-control bg-accent px-5 text-body font-medium text-accent-contrast hover:bg-accent-strong focus-visible:outline-focus"
      >
        {t('narrow.portalLink')}
      </Link>
    </main>
  );
}
