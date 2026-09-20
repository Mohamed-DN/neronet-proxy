import { useTranslation } from 'react-i18next';

/**
 * The first element in the tab order. A keyboard operator would otherwise pass
 * through every entry of the sidebar on every page load before reaching the
 * content.
 *
 * The target must be a focusable element: the main landmark carries tabIndex
 * -1 so the browser moves focus, not only the viewport.
 */
export function SkipLink({ targetId = 'main-content' }: { targetId?: string }) {
  const { t } = useTranslation('ui');
  return (
    <a href={`#${targetId}`} className="skip-link">
      {t('skipToContent')}
    </a>
  );
}
