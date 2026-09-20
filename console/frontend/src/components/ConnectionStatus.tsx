import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CloudOff, RefreshCcw, WifiOff } from 'lucide-react';

import { getConnectionState, subscribeToConnection, type ConnectionState } from '../services/connection';
import { cn } from '../ui';

/**
 * Whether the console is talking to the control plane.
 *
 * This replaces the banner that named the data source. That banner existed
 * because several panels quietly substituted demo fixtures for a failed
 * request, and the screen looked identical whether the mesh was healthy, the
 * backend was down, or the database was empty. The fixtures are gone, so the
 * question the banner answered has narrowed to one an operator still needs
 * answered constantly: is what I am looking at current?
 *
 * Silent when everything works. A permanent green badge trains an operator to
 * stop reading the corner it sits in.
 */
export default function ConnectionStatus() {
  const { t } = useTranslation('chrome');
  const [state, setState] = useState<ConnectionState>(getConnectionState);

  useEffect(() => subscribeToConnection(setState), []);

  if (state.status === 'online' || state.status === 'unknown') return null;

  const offline = state.status === 'offline';
  const Icon = offline ? WifiOff : CloudOff;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'flex items-start gap-3 rounded-card border px-4 py-3 text-caption',
        offline ? 'border-danger/40 bg-danger-subtle text-danger' : 'border-warning/40 bg-warning-subtle text-warning'
      )}
    >
      <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0">
        <p className="font-semibold">{offline ? t('connection.offline') : t('connection.degraded')}</p>
        <p className="mt-1">{offline ? t('connection.offlineBody') : t('connection.degradedBody')}</p>
        {state.reconnectingInMs !== null && (
          <p className="mt-1 flex items-center gap-1.5 font-mono text-micro">
            <RefreshCcw aria-hidden="true" className="h-3 w-3" />
            {t('connection.retryIn', { seconds: Math.round(state.reconnectingInMs / 1000) })}
          </p>
        )}
        {state.lastError && (
          <p className="mt-1 break-words font-mono text-micro opacity-80">
            {t('connection.lastFailure')}: {state.lastError}
          </p>
        )}
      </div>
    </div>
  );
}
