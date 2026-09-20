import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MonitorX } from 'lucide-react';

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

export function NarrowWindow({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation('chrome');
  const wide = useIsWideEnough();

  if (wide) return <>{children}</>;

  return (
    <div
      role="status"
      className="flex flex-col items-center justify-center gap-3 rounded-card border border-dashed border-border px-6 py-16 text-center"
    >
      <MonitorX aria-hidden="true" className="h-6 w-6 text-muted" />
      <h1 className="text-title font-semibold text-content">{t('narrow.title')}</h1>
      <p className="max-w-prose text-caption text-subtle">{t('narrow.body')}</p>
    </div>
  );
}
