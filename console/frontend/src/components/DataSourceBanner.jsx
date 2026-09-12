import React, { useEffect, useState } from 'react';
import { AlertTriangle, WifiOff } from 'lucide-react';
import { subscribeToDataSource } from '../services/dataSource';

/**
 * Persistent notice describing where the data on screen came from.
 *
 * Without this the console renders identically whether the mesh is healthy, the
 * backend is down, or the database is empty. An operator deciding whether their
 * nodes are reporting has to be able to answer that from the screen; a panel full of
 * demo fixtures that looks exactly like a panel full of real devices makes that
 * impossible, and quietly turns a diagnostic tool into a decorative one.
 */
export default function DataSourceBanner() {
  const [state, setState] = useState(null);

  useEffect(() => subscribeToDataSource(setState), []);

  if (!state || state.backend !== 'unreachable') {
    return null;
  }

  const showingMocks = state.isShowingMockData;

  const tone = showingMocks
    ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
    : 'border-red-500/40 bg-red-500/10 text-red-200';

  const Icon = showingMocks ? AlertTriangle : WifiOff;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${tone}`}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        {showingMocks ? (
          <>
            <p className="font-semibold">Showing demo data, not your mesh</p>
            <p className="mt-1 opacity-90">
              The control plane did not answer, so {state.mockedEndpoints.length}{' '}
              {state.mockedEndpoints.length === 1 ? 'panel is' : 'panels are'} filled with
              sample fixtures. Nothing here reflects real devices.
            </p>
            <p className="mt-1 font-mono text-xs opacity-75 break-words">
              {state.mockedEndpoints.join(', ')}
            </p>
          </>
        ) : (
          <>
            <p className="font-semibold">Control plane unreachable</p>
            <p className="mt-1 opacity-90">
              Panels below may be empty because the API did not respond, not because
              your mesh is empty.
            </p>
          </>
        )}
        {state.lastError ? (
          <p className="mt-1 font-mono text-xs opacity-75 break-words">{state.lastError}</p>
        ) : null}
      </div>
    </div>
  );
}
