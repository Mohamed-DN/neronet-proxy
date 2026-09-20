import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertOctagon } from 'lucide-react';

import { Button, CodeText } from '../ui';
import { newErrorId, reportError } from './errorId';

/**
 * The boundary above the router.
 *
 * Every page has its own boundary, so this one catches what those cannot: a
 * failure in the layout, the providers or the router itself. It is a class
 * component because that is the only thing React offers for catching a render
 * error, and it holds no translation hooks of its own - the surface below does.
 */

interface State {
  errorId: string | null;
}

function AppErrorSurface({ errorId }: { errorId: string }) {
  const { t } = useTranslation('chrome');
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface p-6 text-content">
      <div className="w-full max-w-xl space-y-4 rounded-card border border-border bg-surface-raised p-6">
        <div className="flex items-center gap-3 text-danger">
          <AlertOctagon aria-hidden="true" className="h-6 w-6" />
          <h1 className="text-title font-semibold">{t('routeError.appTitle')}</h1>
        </div>
        <p className="text-caption text-subtle">{t('routeError.appBody')}</p>
        <p className="flex items-center gap-2 text-caption text-muted">
          <span>{t('routeError.errorId')}</span>
          <CodeText>{errorId}</CodeText>
        </p>
        <Button onClick={() => window.location.reload()}>{t('routeError.reload')}</Button>
        <p className="text-micro text-subtle">{t('routeError.errorIdHint')}</p>
      </div>
    </div>
  );
}

export class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { errorId: null };

  static getDerivedStateFromError(): State {
    return { errorId: newErrorId() };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // The identifier was generated in getDerivedStateFromError, which runs
    // first; reading it here keeps the log and the screen on the same one.
    reportError(this.state.errorId ?? 'UNKNOWN', { error, componentStack: info.componentStack });
  }

  render(): React.ReactNode {
    if (this.state.errorId) return <AppErrorSurface errorId={this.state.errorId} />;
    return this.props.children;
  }
}
