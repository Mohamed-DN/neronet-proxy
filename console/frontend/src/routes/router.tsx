import { lazy } from 'react';
import { Navigate, type RouteObject } from 'react-router-dom';

import { RequireAuth } from './RequireAuth';
import { RootLayout } from './RootLayout';
import { RouteError } from './RouteError';
import { DEFAULT_PATH, LOGIN_PATH, ROUTES } from './paths';
import { ShellProvider } from './shell';

/*
 * Every page is loaded on demand. The console shipped 2.3 MB of JavaScript to
 * anyone who opened the sign-in form, most of it a WebGL topology and a chart
 * library that the sign-in form and the overview do not use.
 */
const LoginRoute = lazy(() => import('./LoginRoute'));
const NotFoundRoute = lazy(() => import('./NotFoundRoute'));
const OverviewRoute = lazy(() => import('./pages/OverviewRoute'));
const TopologyRoute = lazy(() => import('./pages/TopologyRoute'));
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

function page(path: string, element: React.ReactNode, titleKey: string): RouteObject {
  return {
    path,
    element,
    // Each page has its own boundary. A failure is then contained to the
    // outlet: the parent layout is already rendered, so the header and the
    // sidebar stay usable and the operator can leave the broken page.
    errorElement: <RouteError />,
    handle: { titleKey }
  };
}

export const routes: RouteObject[] = [
  {
    path: LOGIN_PATH,
    element: <LoginRoute />,
    errorElement: <RouteError />
  },
  {
    element: <RequireAuth />,
    errorElement: <RouteError />,
    children: [
      {
        element: (
          <ShellProvider>
            <RootLayout />
          </ShellProvider>
        ),
        errorElement: <RouteError />,
        children: [
          { index: true, element: <Navigate to={DEFAULT_PATH} replace /> },
          page(ROUTES.overview, <OverviewRoute />, 'nav.items.overview'),
          page(ROUTES.topology, <TopologyRoute />, 'nav.items.topology'),
          page(ROUTES.nodes, <NodesRoute />, 'nav.items.nodes'),
          page(`${ROUTES.nodes}/:id`, <NodesRoute />, 'nav.items.nodes'),
          page(ROUTES.onion, <OnionRoute />, 'nav.items.onion'),
          page(ROUTES.peering, <PeeringRoute />, 'nav.items.peering'),
          page(ROUTES.cloudpc, <CloudPcRoute />, 'nav.items.cloudpc'),
          page(ROUTES.risk, <RiskRoute />, 'nav.items.risk'),
          page(ROUTES.acls, <AclsRoute />, 'nav.items.acls'),
          page(ROUTES.audit, <AuditRoute />, 'nav.items.audit'),
          page(ROUTES.users, <UsersRoute />, 'nav.items.users'),
          page(ROUTES.settings, <SettingsRoute />, 'nav.items.settings'),
          page(ROUTES.nuke, <NukeRoute />, 'nav.items.nuke'),
          // Inside the layout, so an operator who mistypes an address keeps
          // the navigation and is one click from a page that exists.
          page('*', <NotFoundRoute />, 'notFound.title')
        ]
      }
    ]
  }
];
