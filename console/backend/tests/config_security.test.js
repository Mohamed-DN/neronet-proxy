const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const BACKEND_DIR = path.resolve(__dirname, '..');

/**
 * Run a snippet in a fresh Node process with a controlled environment.
 *
 * The configuration modules are singletons resolved at require time, so each case
 * needs its own process to see a different environment. Returns { status, output }.
 */
function runInEnv(env, snippet) {
  const res = spawnSync(process.execPath, ['-e', snippet], {
    cwd: BACKEND_DIR,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });

  // Warnings go to stderr and assertions below look for them, so both streams are
  // merged rather than only kept on the failure path.
  const stdout = res.stdout || '';
  const stderr = res.stderr || '';

  return {
    status: res.status === null ? 1 : res.status,
    stdout,
    stderr,
    output: `${stdout}${stderr}`
  };
}

// Production must never fall back to a default that is committed to the repository.
// A deployment that forgets a variable and boots anyway signs tokens with a secret
// every reader of the source already has, and gives no signal that it happened.
describe('Production secret enforcement', () => {
  const PROD = { NODE_ENV: 'production' };
  const clearSecrets = {
    SOVEREIGN_JWT_SECRET: '',
    SOVEREIGN_REFRESH_SECRET: '',
    SOVEREIGN_ADMIN_PASS: '',
    PGPASSWORD: '',
    POSTGRES_PASSWORD: ''
  };

  it('refuses to start in production when JWT secrets are unset', { timeout: 30_000 }, () => {
    const res = runInEnv({ ...PROD, ...clearSecrets }, "require('./config/env').assertProductionSecrets();");

    assert.notStrictEqual(res.status, 0, 'process should have exited non-zero');
    assert.match(res.output, /Refusing to start/);
    assert.match(res.output, /SOVEREIGN_JWT_SECRET/);
    assert.match(res.output, /SOVEREIGN_REFRESH_SECRET/);
    assert.match(res.output, /SOVEREIGN_ADMIN_PASS/);
  });

  it('starts in production once every secret is supplied', { timeout: 30_000 }, () => {
    const res = runInEnv(
      {
        ...PROD,
        SOVEREIGN_JWT_SECRET: 'a-real-secret-value',
        SOVEREIGN_REFRESH_SECRET: 'another-real-secret-value',
        SOVEREIGN_ADMIN_PASS: 'a-real-admin-password'
      },
      "const c = require('./config/env'); c.assertProductionSecrets(); console.log('STARTED', c.missingSecrets.length);"
    );

    assert.strictEqual(res.status, 0, `expected clean start, got: ${res.output}`);
    assert.match(res.output, /STARTED 0/);
  });

  it('does not reuse a published default as the production JWT secret', { timeout: 30_000 }, () => {
    const res = runInEnv(
      {
        ...PROD,
        SOVEREIGN_JWT_SECRET: 'a-real-secret-value',
        SOVEREIGN_REFRESH_SECRET: 'another-real-secret-value',
        SOVEREIGN_ADMIN_PASS: 'a-real-admin-password'
      },
      "console.log(require('./config/env').JWT_SECRET);"
    );

    assert.strictEqual(res.status, 0);
    assert.strictEqual(res.stdout.trim(), 'a-real-secret-value');
    assert.doesNotMatch(res.output, /dev-only/);
  });

  it('still boots in development, with a warning', { timeout: 30_000 }, () => {
    const res = runInEnv(
      { NODE_ENV: 'development', ...clearSecrets },
      "const c = require('./config/env'); c.assertProductionSecrets(); console.log('DEV_OK', c.JWT_SECRET);"
    );

    assert.strictEqual(res.status, 0, `development should not be blocked: ${res.output}`);
    assert.match(res.output, /DEV_OK dev-only-jwt-secret-do-not-deploy/);
    assert.match(res.output, /falling back to a well-known development value/);
  });

  it('refuses a missing PostgreSQL password in production', { timeout: 30_000 }, () => {
    const res = runInEnv(
      {
        ...PROD,
        ...clearSecrets,
        SOVEREIGN_JWT_SECRET: 'x',
        SOVEREIGN_REFRESH_SECRET: 'y',
        SOVEREIGN_ADMIN_PASS: 'z'
      },
      "require('./config/database').postgres.password;"
    );

    assert.notStrictEqual(res.status, 0);
    assert.match(res.output, /PGPASSWORD/);
  });
});

// Enabling TLS must not mean "encrypt but authenticate nothing". A connection that
// accepts any certificate is readable by anyone who can answer on the database's
// address, which is a weaker position than plaintext on a trusted socket.
describe('PostgreSQL TLS verification', () => {
  it('verifies certificates by default when PGSSL is enabled', { timeout: 30_000 }, () => {
    const res = runInEnv(
      { NODE_ENV: 'development', PGSSL: 'true', PGSSL_INSECURE: '' },
      "console.log(JSON.stringify(require('./config/database').postgres.ssl));"
    );

    assert.strictEqual(res.status, 0);
    assert.match(res.output, /"rejectUnauthorized":true/);
  });

  it('disables TLS entirely when PGSSL is not set', { timeout: 30_000 }, () => {
    const res = runInEnv(
      { NODE_ENV: 'development', PGSSL: '', PGSSL_INSECURE: '' },
      "console.log(JSON.stringify(require('./config/database').postgres.ssl));"
    );

    assert.strictEqual(res.status, 0);
    assert.strictEqual(res.stdout.trim(), 'false');
  });

  it('rejects PGSSL_INSECURE in production', { timeout: 30_000 }, () => {
    const res = runInEnv(
      {
        NODE_ENV: 'production',
        PGSSL: 'true',
        PGSSL_INSECURE: 'true',
        SOVEREIGN_JWT_SECRET: 'x',
        SOVEREIGN_REFRESH_SECRET: 'y',
        SOVEREIGN_ADMIN_PASS: 'z'
      },
      "require('./config/database').postgres.ssl;"
    );

    assert.notStrictEqual(res.status, 0);
    assert.match(res.output, /PGSSL_INSECURE/);
  });
});

// A committed example file that arrives with working secret values is how a
// deployment ends up authenticating with a credential anyone can read, and a
// presence check cannot catch it because the variable is set.
describe('Committed files carry no usable secrets', () => {
  const REPO_ROOT = path.resolve(__dirname, '../../..');

  const SECRET_KEYS = [
    'SOVEREIGN_JWT_SECRET',
    'SOVEREIGN_REFRESH_SECRET',
    'SOVEREIGN_ADMIN_PASS',
    'POSTGRES_PASSWORD',
    'PGPASSWORD'
  ];

  const envExamples = ['.env.example', 'console/.env.example'];

  for (const rel of envExamples) {
    it(`${rel} leaves every secret blank`, () => {
      const file = path.join(REPO_ROOT, rel);
      const lines = fs.readFileSync(file, 'utf8').split('\n');

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#') || !trimmed.includes('=')) {
          continue;
        }
        const [key, ...rest] = trimmed.split('=');
        if (SECRET_KEYS.includes(key.trim())) {
          assert.strictEqual(
            rest.join('=').trim(),
            '',
            `${rel} assigns a value to ${key.trim()}; example files must leave secrets empty`
          );
        }
      }
    });
  }

  const composeFiles = ['docker-compose.yml'];

  for (const rel of composeFiles) {
    it(`${rel} takes secrets from the environment, not literals`, () => {
      const file = path.join(REPO_ROOT, rel);
      const lines = fs.readFileSync(file, 'utf8').split('\n');

      for (const line of lines) {
        const trimmed = line.trim().replace(/^-\s*/, '');
        if (trimmed.startsWith('#')) {
          continue;
        }
        for (const key of SECRET_KEYS) {
          if (!trimmed.startsWith(`${key}=`)) {
            continue;
          }
          const value = trimmed.slice(key.length + 1);
          assert.ok(
            value.startsWith('${'),
            `${rel} sets ${key} to a literal; use \${${key}:?...} so Compose fails when it is unset`
          );
        }
      }
    });
  }

  it('rejects any secret that has appeared in a committed file', { timeout: 30_000 }, () => {
    const { isPublishedDefault } = require('../config/env');

    // The historical defaults, reconstructed here only to assert they are refused.
    assert.ok(isPublishedDefault('admin_password'), 'the old admin password should be blocklisted');
    assert.ok(!isPublishedDefault('a-freshly-generated-value'), 'a fresh value must not be blocklisted');
  });
});
