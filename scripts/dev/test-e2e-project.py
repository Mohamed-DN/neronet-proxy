#!/usr/bin/env python3
"""Exercise the real E2E scripts with an engine that only records dispatch.

No Docker/Podman daemon is contacted, even when testing a protected project name.
The disposable fixture contains fake secrets/certificates and copies of the actual
stack/engine scripts. An injected startup failure exercises the real cleanup trap.
"""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
git_bash = Path(os.environ.get('ProgramFiles', 'C:/Program Files')) / 'Git/bin/bash.exe'
SHELL = str(git_bash) if os.name == 'nt' and git_bash.exists() else shutil.which('bash') or shutil.which('sh')
if not SHELL:
    raise RuntimeError('A POSIX shell is required; use Git Bash on Windows')


class E2EProjectProtection(unittest.TestCase):
    def exercise(self, project, arguments=()):
        with tempfile.TemporaryDirectory(prefix='neronet-e2e-project-') as directory:
            fixture = Path(directory).resolve()
            scripts = fixture / 'scripts/dev'
            scripts.mkdir(parents=True)
            for name in ['stack.sh', 'engine.sh']:
                shutil.copyfile(ROOT / 'scripts/dev' / name, scripts / name)
            keys = ['POSTGRES_PASSWORD', 'SOVEREIGN_JWT_SECRET', 'SOVEREIGN_REFRESH_SECRET',
                    'SOVEREIGN_AUDIT_HMAC_SECRET', 'SOVEREIGN_SHRED_KEK_SECRET',
                    'SOVEREIGN_ADMIN_PASS', 'SOVEREIGN_REGISTRATION_TOKEN']
            (fixture / '.env').write_text(''.join(key + '=disposable-recording-fixture\n' for key in keys))
            certs = fixture / 'certs'
            certs.mkdir()
            for name in ['ca.crt', 'server.crt', 'server.key']:
                (certs / name).write_text('disposable-recording-fixture\n')
            binary = fixture / 'bin'
            binary.mkdir()
            engine = binary / 'neronet-recording-engine'
            engine.write_text('''#!/bin/sh
printf '%s|%s\n' "${COMPOSE_PROJECT_NAME:-}" "$*" >> "$NERONET_ENGINE_RECORD"
for argument in "$@"; do
  if [ "$argument" = up ]; then exit 23; fi
done
exit 0
''', encoding='utf-8', newline='\n')
            engine.chmod(0o755)
            record = fixture / 'engine.log'
            env = os.environ.copy()
            # Isolate input from any operator's exported deployment settings.
            for key in list(env):
                if key.startswith(('COMPOSE_', 'NERONET_', 'SOVEREIGN_')):
                    env.pop(key)
            env.update(NERONET_ENGINE='neronet-recording-engine',
                       NERONET_REPO_ROOT=fixture.as_posix(),
                       NERONET_ENGINE_RECORD=record.as_posix(),
                       PATH=str(binary) + os.pathsep + env.get('PATH', ''),
                       MSYS_NO_PATHCONV='1')
            if project is not None:
                env['COMPOSE_PROJECT_NAME'] = project
            result = subprocess.run([SHELL, (ROOT / 'scripts/dev/e2e.sh').as_posix(), *arguments],
                                    cwd=fixture, env=env, capture_output=True, text=True, timeout=15)
            calls = record.read_text().splitlines() if record.exists() else []
            return result, calls

    def assert_protected(self, project, arguments=()):
        result, calls = self.exercise(project, arguments)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls, [], 'Unsafe input reached the container engine: ' + repr(calls))
        self.assertIn('safe COMPOSE_PROJECT_NAME', result.stderr)

    def test_owner_is_rejected_before_startup_or_cleanup(self):
        self.assert_protected('neronet')

    def test_keep_does_not_allow_starting_the_owner_stack(self):
        self.assert_protected('neronet', ('--keep',))

    def test_uppercase_name_is_rejected(self):
        self.assert_protected('NERONET')

    def test_whitespace_name_is_rejected(self):
        self.assert_protected('neronet test')

    def test_explicit_disposable_project_keeps_cleanup(self):
        result, calls = self.exercise('neronet-e2e-fixture')
        self.assertEqual(result.returncode, 23, result.stderr)
        self.assertTrue(any(' up ' in call for call in calls), calls)
        self.assertTrue(any(' down ' in call and '-v' in call for call in calls), calls)
        self.assertTrue(all(call.startswith('neronet-e2e-fixture|') for call in calls))

    def test_default_disposable_project_keeps_cleanup(self):
        result, calls = self.exercise(None)
        self.assertEqual(result.returncode, 23, result.stderr)
        self.assertTrue(any(' down ' in call and '-v' in call for call in calls), calls)
        self.assertTrue(all(call.startswith('neronet-e2e|') for call in calls))


if __name__ == '__main__':
    unittest.main(verbosity=2)
