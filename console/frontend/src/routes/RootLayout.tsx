import { Suspense, lazy, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Outlet, useMatches } from 'react-router-dom';

import ConnectionStatus from '../components/ConnectionStatus';
import Header from '../components/Header';
import Sidebar from '../components/Sidebar';
import { useAuth } from '../context/AuthContext';
import { api } from '../services/api';
import { fleetCounts, queryKeys, useFeatures, useLiveUpdates, useNodes } from '../services/queries';
import { Skeleton, SkipLink } from '../ui';
import { NarrowWindow } from './NarrowWindow';
import { useShell } from './shell';

/*
 * The enrolment dialog carries a QR encoder and a key generator that no other
 * page needs, so it loads when it is first opened rather than with the shell.
 */
const CryptoConfigModal = lazy(() => import('../components/CryptoConfigModal.jsx'));

/** Set on a route to name the page in the document title. */
export interface RouteHandle {
  titleKey?: string;
}

function usePageTitle(): void {
  const { t } = useTranslation('chrome');
  const matches = useMatches();

  useEffect(() => {
    const match = [...matches].reverse().find((entry) => (entry.handle as RouteHandle | undefined)?.titleKey);
    const titleKey = (match?.handle as RouteHandle | undefined)?.titleKey;
    document.title = titleKey ? t('page.title', { page: t(titleKey) }) : 'NeroNet Console';
  }, [matches, t]);
}

/**
 * The shell every page is drawn inside.
 *
 * It owns the landmark structure - one banner, one navigation, one main region
 * - the skip link's target, the connection indicator, the live channel and the
 * document title. It does not own the pages: they arrive through the outlet,
 * each in its own chunk and each with its own error boundary, so a page that
 * throws leaves this standing.
 */
export function RootLayout() {
  const { t } = useTranslation('chrome');
  const queryClient = useQueryClient();
  const { logout } = useAuth();
  const features = useFeatures();
  const nodes = useNodes();
  const shell = useShell();

  usePageTitle();
  // One socket for the whole console, held for as long as there is a session.
  useLiveUpdates(true);

  const counts = fleetCounts(nodes.data);

  /*
   * Tier 1 self-destruct. Unchanged in substance from the shell it replaces:
   * the control plane performs the deletion and the console reports only what
   * the control plane confirmed. A failure is shown, never swallowed, because
   * what follows it is irreversible.
   */
  const handleExecuteWipe = async () => {
    if (
      !window.confirm(
        'FINAL WARNING: This is the Point of No Return. Executing will PERMANENTLY DESTROY the account and network assets. Execute?'
      )
    ) {
      return;
    }
    try {
      await api.nuke.userSelfDestruct('DELETE MY ACCOUNT', true);
      window.alert('DESTRUCTION COMPLETE. System wiped. Logging out.');
      shell.disarmNuke();
      await logout();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Wipe failed');
    }
  };

  return (
    <div className="flex min-h-screen bg-surface font-sans text-content">
      {/* First stop in the tab order: past the whole sidebar, to the page. */}
      <SkipLink />

      <Sidebar
        features={features.data ?? { cloud_pc: false }}
        nodeCount={counts.total}
        reachableCount={counts.reachable}
        quarantinedCount={counts.quarantined}
        highRiskCount={counts.highRisk}
        nukeArmed={shell.nukeArmed}
        nukeScheduledAt={shell.nukeScheduledAt}
        onExecuteWipe={handleExecuteWipe}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <Header onOpenEnrollModal={shell.openEnroll} />

        {/* tabIndex -1 so the skip link moves focus here and not only the
            viewport. */}
        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto w-full max-w-7xl flex-1 p-6 focus-visible:outline-focus"
        >
          <NarrowWindow>
            <div className="mb-4">
              <ConnectionStatus />
            </div>
            <Suspense
              fallback={
                <div>
                  <p className="sr-only" role="status">
                    {t('page.loading')}
                  </p>
                  <Skeleton lines={8} />
                </div>
              }
            >
              <Outlet />
            </Suspense>
          </NarrowWindow>
        </main>
      </div>

      {shell.enrollOpen && (
        <Suspense fallback={null}>
          <CryptoConfigModal
            isOpen
            onClose={shell.closeEnroll}
            onNodeEnrolled={() => {
              void queryClient.invalidateQueries({ queryKey: queryKeys.nodes });
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
