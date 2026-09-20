import { useNavigate } from 'react-router-dom';

import BehavioralRiskDashboard from '../../components/BehavioralRiskDashboard.jsx';
import { PageFrame } from '../PageFrame';
import { nodePath } from '../paths';

export default function RiskRoute() {
  const navigate = useNavigate();
  return (
    <PageFrame>
      <BehavioralRiskDashboard onSelectNode={(node: { id: string }) => navigate(nodePath(node.id))} />
    </PageFrame>
  );
}
