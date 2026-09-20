import { Suspense, lazy } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';

import NodeMatrix from '../../components/NodeMatrix.jsx';
import { queryKeys, useNode } from '../../services/queries';
import type { MeshNode } from '../../services/types';
import { PageFrame } from '../PageFrame';
import { QueryBoundary } from '../QueryBoundary';
import { ROUTES, nodePath, type RouteId } from '../paths';
import { useShell } from '../shell';

/*
 * The drawer is opened from four different pages and carries the node actions,
 * so it is loaded when a node is first selected rather than with the matrix.
 */
const NodeActions = lazy(() => import('../../components/NodeActions.jsx'));

/**
 * The node matrix, and one node's detail drawer at /nodes/:id.
 *
 * The drawer used to be shell state with no address, so a node could not be
 * linked to and a refresh lost the selection. It is now the route: the same URL
 * opened in another browser shows the same node.
 */
export default function NodesRoute() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const shell = useShell();
  const node = useNode(id);

  const closeDrawer = () => navigate(ROUTES.nodes);
  const refreshFleet = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.nodes });
  };

  return (
    <PageFrame>
      <NodeMatrix
        onSelectNode={(selected: MeshNode) => navigate(nodePath(selected.id))}
        onOpenEnrollModal={shell.openEnroll}
      />

      {id && (
        <QueryBoundary query={node} loadingLines={2}>
          {(selected) => (
            <Suspense fallback={null}>
              <NodeActions
                node={selected}
                isOpen
                onClose={closeDrawer}
                onNodeUpdated={refreshFleet}
                onNodeRevoked={() => {
                  refreshFleet();
                  closeDrawer();
                }}
                onNavigateTab={(tab: RouteId) => navigate(ROUTES[tab] ?? ROUTES.nodes)}
              />
            </Suspense>
          )}
        </QueryBoundary>
      )}
    </PageFrame>
  );
}
