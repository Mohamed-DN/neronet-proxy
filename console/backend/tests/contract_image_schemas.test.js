// The backend image validates node requests against its own copy of the wire
// schemas (console/backend/api/contract/v4, SOVEREIGN_CONTRACT_SCHEMA_DIR in
// docker-compose.yml), while the rest of the suite reads the repository-root copy.
// A field the node sends that only the root copy knows passes every other test
// and is refused with 400 in production. This compiles the image copy on its own
// and holds the shared fixtures, which carry the node's transport fields, to it.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const IMAGE_DIR = path.resolve(__dirname, '../api/contract/v4');
const ROOT_DIR = path.resolve(__dirname, '../../../api/contract/v4');
const FIXTURES_DIR = path.join(ROOT_DIR, 'fixtures');

// Exactly what the container does; each test file runs in its own process.
process.env.SOVEREIGN_CONTRACT_SCHEMA_DIR = IMAGE_DIR;
const { validateResponse, validators } = require('../middleware/contractValidator');

describe('backend image copy of the wire schemas', () => {
  it('has the same schema files as the generated root copy', () => {
    const names = (dir) =>
      fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.schema.json'))
        .sort();
    assert.deepStrictEqual(names(IMAGE_DIR), names(ROOT_DIR));
    for (const file of names(ROOT_DIR)) {
      assert.strictEqual(
        fs.readFileSync(path.join(IMAGE_DIR, file), 'utf8'),
        fs.readFileSync(path.join(ROOT_DIR, file), 'utf8'),
        `${file} differs between the image copy and the generated schemas`
      );
    }
  });

  for (const file of fs
    .readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    const typeName = file.replace('.json', '');
    it(`accepts the shared fixture ${file}`, () => {
      assert.ok(validators.has(typeName), `the image copy has no schema for ${typeName}`);
      const data = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8'));
      const result = validateResponse(typeName, data);
      assert.strictEqual(result.valid, true, `${result.pointer} ${result.message}`);
    });
  }

  it('the fixtures exercise the node transport report and capability fields', () => {
    const register = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'RegisterRequest.json'), 'utf8'));
    const heartbeat = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'HeartbeatRequest.json'), 'utf8'));
    const netmap = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'NetmapResponse.json'), 'utf8'));
    assert.ok(Array.isArray(register.capability.transports) && register.capability.transports.length > 0);
    assert.ok(Array.isArray(register.capability.capabilities) && register.capability.capabilities.length > 0);
    assert.strictEqual(heartbeat.transport_report_version, 'derp-v2');
    assert.ok(heartbeat.relay_homes.length > 0 && heartbeat.peer_paths.length > 0);
    // Counters above 2^53 must survive JSON.parse unchanged.
    assert.strictEqual(heartbeat.peer_paths[0].wg_rx_bytes, '18446744073709551615');
    assert.strictEqual(netmap.transport_policy_version, 'derp-v2');
    assert.ok(netmap.relay_candidates.length > 0);
  });
});
