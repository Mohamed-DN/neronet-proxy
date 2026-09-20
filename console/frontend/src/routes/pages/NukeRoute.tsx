import { Suspense, lazy, useState } from 'react';

import NeroNukePanel from '../../components/NeroNukePanel.jsx';
import { PageFrame } from '../PageFrame';
import { useShell } from '../shell';

const NeroNukeSecretAccessModal = lazy(() => import('../../components/NeroNukeSecretAccessModal.jsx'));

export default function NukeRoute() {
  const shell = useShell();
  const [secretOpen, setSecretOpen] = useState(false);

  return (
    <PageFrame>
      <NeroNukePanel
        nukeArmed={shell.nukeArmed}
        nukeScheduledAt={shell.nukeScheduledAt}
        onArmNuke={shell.armNuke}
        onDisarmNuke={shell.disarmNuke}
        onOpenSecretModal={() => setSecretOpen(true)}
      />
      {secretOpen && (
        <Suspense fallback={null}>
          <NeroNukeSecretAccessModal isOpen onClose={() => setSecretOpen(false)} onAuthenticated={() => {}} />
        </Suspense>
      )}
    </PageFrame>
  );
}
