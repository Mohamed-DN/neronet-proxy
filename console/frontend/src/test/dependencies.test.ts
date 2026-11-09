import { describe, expect, it } from 'vitest';

import pkg from '../../package.json';

const THREE_D_PACKAGES = ['three', 'react-force-graph-3d', 'three-spritetext'];

const LEGACY_PAGES = [
  'AuditLogs',
  'MeshSettings',
  'NeroNukePanel',
  'NeroNukeSecretAccessModal',
  'NodeActions',
  'NodeMatrix',
  'SettingsACL',
  'Topology3D',
  'UserManagement',
  'Overview'
];

// Every file under src/components, by path. Vite resolves this at build time,
// so a deleted file is absent here whether or not anything still imports it.
const componentFiles = Object.keys(import.meta.glob('/src/components/*.{js,jsx,ts,tsx}'));

describe('dead dependencies and legacy pages', () => {
  it('package.json has no 3D dependency', () => {
    const deps = Object.keys(pkg.dependencies);
    for (const name of THREE_D_PACKAGES) {
      expect(deps).not.toContain(name);
    }
  });

  it('the ten legacy files are gone', () => {
    for (const name of LEGACY_PAGES) {
      expect(componentFiles, `${name}.jsx still exists`).not.toContain(`/src/components/${name}.jsx`);
    }
  });
});
