import { Suspense, lazy } from 'react';
import { type RouteObject } from 'react-router-dom';

import { useAuth } from '../context/AuthContext';
import PortalLayout from '../portal/PortalLayout';
import { useFeatures } from '../services/queries/features';
import { effectiveRole, roleTier, type PageId } from '../services/roles';
import { Skeleton } from '../ui/States';
import { RequireAuth } from './RequireAuth';
import { RequireRole, RoleLanding } from './RequireRole';
import { RootLayout } from './RootLayout';
import { RouteError } from './RouteError';
import { INVITE_PATH, LOGIN_PATH, ROUTES } from './paths';
import { ShellProvider } from './shell';

/*
 * Every page is loaded on demand. The console shipped 2.3 MB of JavaScript to
 * anyone who opened the sign-in form, most of it a WebGL topology and a chart
 * library that the sign-in form and the overview do not use. The phone page
 * (`/me`) is a chunk of its own, so its first load is measured on its own.
 */
const LoginRoute = lazy(() => import('./LoginRoute'));
const NotFoundRoute = lazy(() => import('./NotFoundRoute'));
const GlossaryRoute = lazy(() => import('./GlossaryRoute'));
const MeRoute = lazy(() => import('../portal/MeRoute'));
const AddDeviceRoute = lazy(() => import('../portal/AddDeviceRoute'));
const InviteAcceptRoute = lazy(() => import('../portal/InviteAcceptRoute'));
const OverviewRoute = lazy(() => import('./pages/OverviewRoute'));
const TopologyRoute = lazy(() => import('./pages/TopologyRoute'));
const SubnetsRoute = lazy(() => import('./pages/SubnetsRoute'));
const NodesRoute = lazy(() => import('./pages/NodesRoute'));
const OnionRoute = lazy(() => import('./pages/OnionRoute'));
const PeeringRoute = lazy(() => import('./pages/PeeringRoute'));
const CloudPcRoute = lazy(() => import('./pages/CloudPcRoute'));
const RiskRoute = lazy(() => import('./pages/RiskRoute'));
const AclsRoute = lazy(() => import('./pages/AclsRoute'));
const AuditRoute = lazy(() => import('./pages/AuditRoute'));
const UsersRoute = lazy(() => import('./pages/UsersRoute'));
const SettingsRoute = lazy(() => import('./pages/SettingsRoute'));
const NukeRoute = lazy(() => import('./pages/NukeRoute'));

/**
 * Waits for the server's feature answer before it decides, so a page behind a
 * feature flag never flashes "forbidden" while the answer is on its way.
 */
function Guarded({ page, children }: { page: PageId; children: React.ReactNode }) {
  const features = useFeatures();
  if (features.isPending) return <Skeleton lines={6} />;
  return (
    <RequireRole page={page} features={features.data}>
      {children}
    </RequireRole>
  );
}

/**
 * A phone page. The portal frame has no Suspense boundary of its own (the
 * console shell has one), so a lazily loaded portal page brings its own.
 */
function portalPage(path: string, element: React.ReactNode, titleKey: string): RouteObject {
  return {
    path,
    element: <Suspense fallback={<Skeleton lines={6} />}>{element}</Suspense>,
    errorElement: <RouteError />,
    handle: { titleKey }
  };
}

function page(path: string, id: PageId, element: React.ReactNode, titleKey: string): RouteObject {
  return {
    path,
    element: <Guarded page={id}>{element}</Guarded>,
    // Each page has its own boundary. A failure is then contained to the
    // outlet: the parent layout is already rendered, so the header and the
    // sidebar stay usable and the operator can leave the broken page.
    errorElement: <RouteError />,
    handle: { titleKey }
  };
}

/**
 * The console shell for every role that works in the console. A `self` role
 * never sees it: that role's own pages, and the glossary, sit in the portal
 * frame instead.
 */
function ConsoleOrPortal() {
  const { user } = useAuth();
  if (roleTier(effectiveRole(user)) === 'self') return <PortalLayout />;
  return (
    <ShellProvider>
      <RootLayout />
    </ShellProvider>
  );
}

export const routes: RouteObject[] = [
  {
    path: LOGIN_PATH,
    element: <LoginRoute />,
    errorElement: <RouteError />
  },
  {
    // Public, like the sign-in: the person opening an invitation has no account yet.
    path: INVITE_PATH,
    element: (
      <Suspense fallback={<Skeleton lines={6} />}>
        <InviteAcceptRoute />
      </Suspense>
    ),
    errorElement: <RouteError />
  },
  {
    element: <RequireAuth />,
    errorElement: <RouteError />,
    children: [
      {
        // A member's own devices, with no console navigation around them.
        element: <PortalLayout />,
        errorElement: <RouteError />,
        children: [
          portalPage(ROUTES.me, <MeRoute />, 'nav.items.me'),
          portalPage(ROUTES.meAdd, <AddDeviceRoute />, 'nav.items.me')
        ]
      },
      {
        element: <ConsoleOrPortal />,
        errorElement: <RouteError />,
        children: [
          { index: true, element: <RoleLanding /> },
          page(ROUTES.overview, 'overview', <OverviewRoute />, 'nav.items.overview'),
          page(ROUTES.topology, 'topology', <TopologyRoute />, 'nav.items.topology'),
          page(ROUTES.subnets, 'subnets', <SubnetsRoute />, 'nav.items.subnets'),
          page(ROUTES.nodes, 'nodes', <NodesRoute />, 'nav.items.nodes'),
          page(`${ROUTES.nodes}/:id`, 'nodes', <NodesRoute />, 'nav.items.nodes'),
          page(ROUTES.onion, 'onion', <OnionRoute />, 'nav.items.onion'),
          page(ROUTES.peering, 'peering', <PeeringRoute />, 'nav.items.peering'),
          page(ROUTES.cloudpc, 'cloudpc', <CloudPcRoute />, 'nav.items.cloudpc'),
          page(ROUTES.risk, 'risk', <RiskRoute />, 'nav.items.risk'),
          page(ROUTES.acls, 'acls', <AclsRoute />, 'nav.items.acls'),
          page(ROUTES.audit, 'audit', <AuditRoute />, 'nav.items.audit'),
          page(ROUTES.users, 'users', <UsersRoute />, 'nav.items.users'),
          page(ROUTES.settings, 'settings', <SettingsRoute />, 'nav.items.settings'),
          page(ROUTES.nuke, 'nuke', <NukeRoute />, 'nav.items.nuke'),
          page(ROUTES.glossary, 'glossary', <GlossaryRoute />, 'nav.items.glossary'),
          // Inside the layout, so an operator who mistypes an address keeps
          // the navigation and is one click from a page that exists.
          {
            path: '*',
            element: <NotFoundRoute />,
            errorElement: <RouteError />,
            handle: { titleKey: 'notFound.title' }
          }
        ]
      }
    ]
  }
];
