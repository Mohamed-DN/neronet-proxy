import { useNavigate } from 'react-router-dom';

import Overview from '../../components/Overview.jsx';
import { PageFrame } from '../PageFrame';
import { ROUTES, nodePath, type RouteId } from '../paths';

export default function OverviewRoute() {
  const navigate = useNavigate();
  return (
    <PageFrame>
      <Overview
        onSelectNode={(node: { id: string }) => navigate(nodePath(node.id))}
        onNavigateTab={(tab: RouteId) => navigate(ROUTES[tab] ?? ROUTES.overview)}
      />
    </PageFrame>
  );
}
