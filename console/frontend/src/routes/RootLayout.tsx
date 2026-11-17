import { Suspense, lazy, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Outlet, useLocation, useMatches } from 'react-router';

import ConnectionStatus from '../components/ConnectionStatus';
import TopBar from '../components/TopBar';
import { useAuth } from '../context/AuthContext';
import { api } from '../services/api';
import { fleetCounts, useFeatures, useLiveUpdates, useNodes } from '../services/queries';
import { BreadcrumbContext, ConfirmDialog, Skeleton, SkipLink, useToast, type Breadcrumb } from '../ui';
import { NarrowWindow, useIsWideEnough } from './NarrowWindow';
import { locate } from './navModel';
import { useShell } from './shell';

/*
 * The add-device dialog carries a QR encoder and a key generator that no other
 * page needs, so it loads when it is first opened rather than with the shell.
 */
const AddDeviceDialog = lazy(() => import('../devices/AddDeviceDialog'));

/** Set on a route to name the page in the document title. */
export interface RouteHandle {
  titleKey?: string;
}

const WIPE_PHRASE = 'DELETE MY ACCOUNT';

function usePageTitle(): void {
  const { t } = useTranslation('chrome');
  const matches = useMatches();

  useEffect(() => {
    const match = [...matches].reverse().find((entry) => (entry.handle as RouteHandle | undefined)?.titleKey);
    const titleKey = (match?.handle as RouteHandle | undefined)?.titleKey;
    document.title = titleKey ? t('page.title', { page: t(titleKey) }) : 'NeroNet Console';
  }, [matches, t]);
}

/** "Network > Map": the group and the page the address belongs to, for PageHeader. */
function useBreadcrumb(): Breadcrumb | null {
  const { t } = useTranslation('chrome');
  const { pathname } = useLocation();
  const here = locate(pathname);
  if (!here) return null;
  const trail = here.group ? [t(`nav.groups.${here.group}`), t(`nav.items.${here.id}`)] : [t(`nav.items.${here.id}`)];
  return { label: t('nav.breadcrumb'), trail };
}

/**
 * The shell every page is drawn inside.
 *
 * It owns the landmark structure - one banner (the top bar), one navigation,
 * one main region - the skip link's target, the connection indicator, the live channel and the
 * document title. It does not own the pages: they arrive through the outlet,
 * each in its own chunk and each with its own error boundary, so a page that
 * throws leaves this standing.
 */
export function RootLayout() {
  const { t } = useTranslation('chrome');
  const { logout } = useAuth();
  const features = useFeatures();
  const nodes = useNodes();
  const shell = useShell();
  const wide = useIsWideEnough();
  const { notify } = useToast();
  const [wipeOpen, setWipeOpen] = useState(false);
  const [wipeBusy, setWipeBusy] = useState(false);
  const [wipeFailed, setWipeFailed] = useState(false);

  usePageTitle();
  const breadcrumb = useBreadcrumb();
  // One socket for the whole console, held for as long as there is a session.
  useLiveUpdates(true);

  const counts = fleetCounts(nodes.data);

  /*
   * Deleting the account is irreversible, so it is asked for in a dialog that
   * needs the exact phrase. The control plane performs the deletion and the
   * console reports only what it confirmed. A failure stays on screen, inside
   * the dialog, so the operator knows nothing was removed.
   */
  const handleWipe = async () => {
    setWipeBusy(true);
    setWipeFailed(false);
    try {
      await api.nuke.userSelfDestruct(WIPE_PHRASE, true);
    } catch {
      setWipeBusy(false);
      setWipeFailed(true);
      return;
    }
    setWipeBusy(false);
    setWipeOpen(false);
    shell.disarmNuke();
    notify(t('wipe.done'), { tone: 'success' });
    await logout();
  };

  // Below 1024 px the admin pages are not offered at all: the notice replaces
  // the whole shell so no bar sits over it.
  if (!wide) return <NarrowWindow />;

  return (
    <div data-shell-root className="bg-surface font-sans text-content">
      {/* First stop in the tab order: past the whole top bar, to the page. */}
      <SkipLink />

      <TopBar
        features={features.data ?? { cloud_pc: false }}
        nodeCount={counts.total}
        reachableCount={counts.reachable}
        quarantinedCount={counts.quarantined}
        highRiskCount={counts.highRisk}
        nukeArmed={shell.nukeArmed}
        nukeScheduledAt={shell.nukeScheduledAt}
        onExecuteWipe={() => setWipeOpen(true)}
        onOpenEnrollModal={shell.openEnroll}
      />

      {/* tabIndex -1 so the skip link moves focus here and not only the
          viewport. Left-aligned on the grid, 1360 px at most. */}
      <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-[1360px] p-6 focus-visible:outline-focus">
        <div className="mb-4">
          <ConnectionStatus />
        </div>
        <BreadcrumbContext.Provider value={breadcrumb}>
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
        </BreadcrumbContext.Provider>
      </main>

      <ConfirmDialog
        open={wipeOpen}
        onOpenChange={(open) => {
          if (!wipeBusy) setWipeOpen(open);
        }}
        title={t('wipe.title')}
        description={t('wipe.body')}
        confirmPhrase={WIPE_PHRASE}
        confirmLabel={t('wipe.confirm')}
        tone="danger"
        busy={wipeBusy}
        onConfirm={() => void handleWipe()}
      >
        {wipeFailed && (
          <p
            role="alert"
            className="rounded-control border border-danger/40 bg-danger-subtle p-3 text-caption text-danger"
          >
            {t('wipe.failed')}
          </p>
        )}
      </ConfirmDialog>

      {shell.enrollOpen && (
        <Suspense fallback={null}>
          <AddDeviceDialog open onOpenChange={(open) => !open && shell.closeEnroll()} />
        </Suspense>
      )}
    </div>
  );
}
