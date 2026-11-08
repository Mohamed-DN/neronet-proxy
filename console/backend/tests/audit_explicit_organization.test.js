const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Every production audit write states its tenant explicitly. A forgotten property
// used to be stored as NULL, indistinguishable from a deliberate platform event and
// invisible to tenant-scoped audit reads. Platform/system events therefore write
// `organizationId: null` on purpose. Whether each value is the right one is proven
// by the behavioural caller tests; this guard proves none was left implicit.
const backend = path.resolve(process.env.AUDIT_GUARD_ROOT || path.join(__dirname, '..'));

function sources(directory) {
  const entries = fs.existsSync(directory) ? fs.readdirSync(directory, { withFileTypes: true }) : [];
  return entries.flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

/** The object literal passed to each logAuditEvent call, by brace matching. */
function auditCalls(file) {
  const text = fs.readFileSync(file, 'utf8');
  const calls = [];
  const pattern = /logAuditEvent\(\s*\{/g;
  let match;
  while ((match = pattern.exec(text))) {
    let depth = 0;
    let end = match.index + match[0].length - 1;
    for (; end < text.length; end++) {
      if (text[end] === '{') depth++;
      else if (text[end] === '}' && --depth === 0) break;
    }
    const literal = text.slice(match.index + match[0].length - 1, end + 1);
    const line = text.slice(0, match.index).split('\n').length;
    const type = /eventType:\s*['"`]?([A-Za-z0-9_.:-]+)/.exec(literal)?.[1] ?? '?';
    calls.push({ file: path.relative(backend, file).replace(/\\/g, '/'), line, type, literal });
  }
  return calls;
}

describe('Production audit writes state their organization explicitly', () => {
  const files = ['routes', 'services', 'middleware', 'modules', 'ws', 'utils']
    .flatMap((directory) => sources(path.join(backend, directory)))
    .filter((file) => !file.endsWith(path.join('utils', 'audit.js')));
  const calls = files.flatMap(auditCalls);

  it('finds the production audit callers it guards', () => {
    assert.ok(calls.length >= 60, `expected the known audit callers, found ${calls.length}`);
  });

  it('passes organizationId in every logAuditEvent object literal', () => {
    const missing = calls
      .filter((call) => !/(^|[\s,{])organizationId\s*[:,}]/m.test(call.literal))
      .map((call) => `${call.file}:${call.line} ${call.type}`);
    assert.deepEqual(missing, [], `audit writes without an explicit organizationId:\n${missing.join('\n')}`);
  });

  it('never takes the audit organization from request input', () => {
    const fromInput = calls
      .filter((call) => /organizationId\s*:[^,\n]*req\.(body|query|params)/.test(call.literal))
      .map((call) => `${call.file}:${call.line} ${call.type}`);
    assert.deepEqual(fromInput, []);
  });
});
