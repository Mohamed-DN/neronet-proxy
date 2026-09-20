import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { FileQuestion } from 'lucide-react';

import { DEFAULT_PATH } from './paths';

/** An address that belongs to no page. Distinct from a page that failed. */
export default function NotFoundRoute() {
  const { t } = useTranslation('chrome');

  useEffect(() => {
    document.title = t('page.title', { page: t('notFound.title') });
  }, [t]);

  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-card border border-dashed border-border px-6 py-16 text-center">
      <FileQuestion aria-hidden="true" className="h-6 w-6 text-muted" />
      <h1 className="text-title font-semibold text-content" tabIndex={-1}>
        {t('notFound.title')}
      </h1>
      <p className="max-w-prose text-caption text-subtle">{t('notFound.body')}</p>
      <Link
        to={DEFAULT_PATH}
        className="rounded-control border border-border-strong bg-surface-raised px-3.5 py-2 text-body text-content hover:bg-surface-hover focus-visible:outline-focus"
      >
        {t('notFound.back')}
      </Link>
    </div>
  );
}
