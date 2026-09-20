import { useNavigate } from 'react-router-dom';

import Topology3D from '../../components/Topology3D.jsx';
import { PageFrame } from '../PageFrame';
import { nodePath } from '../paths';

/*
 * three, react-force-graph-3d and three-spritetext are reached only from here.
 * Splitting this route is what keeps 373 kB of gzipped WebGL out of the login
 * and overview path.
 */
export default function TopologyRoute() {
  const navigate = useNavigate();
  return (
    <PageFrame>
      <Topology3D onSelectNode={(node: { id: string }) => navigate(nodePath(node.id))} />
    </PageFrame>
  );
}
