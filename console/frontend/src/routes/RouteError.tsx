import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { isRouteErrorResponse, useNavigate, useRouteError } from 'react-router-dom';
import { AlertOctagon } from 'lucide-react';

import { Button, Card, CodeText } from '../ui';
import { newErrorId, reportError } from './errorId';
import { DEFAULT_PATH } from './paths';

/**
 * What one page shows when it throws.
 *
 * Attached to every route, so the failure is contained: the header and the
 * sidebar are rendered by the parent layout and stay usable, and the operator
 * can move to another page instead of reloading the console. The console
 * previously had a single boundary at the root, and any render error in any
 * panel blanked the whole window.
 *
 * Nothing about the error reaches the screen except an identifier. The full
 * error goes to the browser console under that identifier.
 */
export function RouteError() {
  const { t } = useTranslation('chrome');
  const error = useRouteError();
  const navigate = useNavigate();
  const id = useMemo(() => newErrorId(), []);

  useEffect(() => {
    reportError(id, error);
  }, [id, error]);

  // A 404 from the router itself is not a crash and reads as one if it is shown
  // with a recovery action for a broken page.
  const isNotFound = isRouteErrorResponse(error) && error.status === 404;

  return (
    <Card className="mx-auto max-w-2xl">
      <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
        <AlertOctagon aria-hidden="true" className="h-6 w-6 text-danger" />
        <h1 className="text-title font-semibold text-content" tabIndex={-1}>
          {isNotFound ? t('notFound.title') : t('routeError.title')}
        </h1>
        <p className="max-w-prose text-caption text-subtle">{isNotFound ? t('notFound.body') : t('routeError.body')}</p>
        {!isNotFound && (
          <p className="flex items-center gap-2 text-caption text-muted">
            <span>{t('routeError.errorId')}</span>
            <CodeText>{id}</CodeText>
          </p>
        )}
        <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
          {!isNotFound && <Button onClick={() => navigate(0)}>{t('routeError.retry')}</Button>}
          <Button variant="secondary" onClick={() => navigate(DEFAULT_PATH)}>
            {t('routeError.overview')}
          </Button>
        </div>
        {!isNotFound && <p className="max-w-prose text-micro text-subtle">{t('routeError.errorIdHint')}</p>}
      </div>
    </Card>
  );
}
