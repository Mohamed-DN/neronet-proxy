// ADR 0037: the pure resolution of the connection order. No database, no mocks: the
// function takes plain settings of each scope and answers the effective order and where
// it came from.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const ConnectionOrderService = require('../services/ConnectionOrderService');

const { resolve, resolveLink, validateOrder, DEFAULT_ORDER } = ConnectionOrderService;
const WG = 'wireguard';
const WSS = 'wireguard-wss';
const AWG = 'amneziawg';
const ALL = [WG, WSS, AWG];
const org = (extra = {}) => ({ allowed: ALL, order: null, forced: false, membersMayChoose: false, ...extra });

describe('ADR 0037: organisation scope', () => {
  it('defaults to Automatico: wireguard, then 443, then AmneziaWG, filtered to what is allowed', () => {
    assert.deepEqual(DEFAULT_ORDER, [WG, WSS, AWG]);
    const all = resolve({ organization: org() });
    assert.deepEqual(all.order, [WG, WSS, AWG]);
    assert.equal(all.origin.scope, 'default');
    assert.equal(all.forced, false);
    assert.deepEqual(resolve({ organization: org({ allowed: [WG, WSS] }) }).order, [WG, WSS]);
    assert.deepEqual(resolve({ organization: org({ allowed: [WG, AWG] }) }).order, [WG, AWG]);
  });

  it('always keeps plain WireGuard in the ceiling', () => {
    assert.deepEqual(resolve({ organization: org({ allowed: [] }) }).order, [WG]);
    assert.deepEqual(resolve({ organization: org({ allowed: [WSS] }) }).order, [WG, WSS]);
  });

  it('uses its own order and names the organisation as origin', () => {
    const r = resolve({ organization: org({ order: [AWG, WG] }) });
    assert.deepEqual(r.order, [AWG, WG]);
    assert.equal(r.origin.scope, 'organization');
  });

  it('drops methods the ceiling does not allow', () => {
    const r = resolve({ organization: org({ allowed: [WG, WSS], order: [AWG, WSS, WG] }) });
    assert.deepEqual(r.order, [WSS, WG]);
    assert.equal(r.origin.scope, 'organization');
  });

  it('falls back to Automatico and says so when nothing of its own order is allowed', () => {
    const r = resolve({ organization: org({ allowed: [WG], order: [AWG] }) });
    assert.deepEqual(r.order, [WG]);
    assert.equal(r.origin.scope, 'default');
    assert.equal(r.clamped, true);
  });

  it('forces only the first method', () => {
    const r = resolve({ organization: org({ order: [WSS, WG], forced: true }) });
    assert.deepEqual(r.order, [WSS]);
    assert.equal(r.forced, true);
    assert.equal(r.origin.scope, 'organization');
  });

  it('ignores reserved or unknown names in stored data', () => {
    const r = resolve({ organization: org({ order: ['vless-reality', 'openvpn', WSS, 'bogus'] }) });
    assert.deepEqual(r.order, [WSS]);
  });
});

describe('ADR 0037: line scope', () => {
  it('inherits when it has no order of its own', () => {
    const r = resolve({
      organization: org({ order: [WSS, WG] }),
      line: { id: 'l1', name: 'Viaggiatori', order: null }
    });
    assert.deepEqual(r.order, [WSS, WG]);
    assert.equal(r.origin.scope, 'organization');
  });

  it('takes its own subset and names the line', () => {
    const r = resolve({ organization: org(), line: { id: 'l1', name: 'Viaggiatori', order: [WSS, WG] } });
    assert.deepEqual(r.order, [WSS, WG]);
    assert.deepEqual(r.origin, { scope: 'line', id: 'l1', name: 'Viaggiatori' });
  });

  it('may enable a method the organisation base order leaves out, if the ceiling allows it', () => {
    const r = resolve({ organization: org({ order: [WG] }), line: { id: 'l1', name: 'L', order: [AWG, WG] } });
    assert.deepEqual(r.order, [AWG, WG]);
  });

  it('cannot go above the ceiling', () => {
    const r = resolve({ organization: org({ allowed: [WG, WSS] }), line: { id: 'l1', name: 'L', order: [AWG, WSS] } });
    assert.deepEqual(r.order, [WSS]);
  });

  it('inherits and flags it when none of its methods survive the ceiling', () => {
    const r = resolve({ organization: org({ allowed: [WG] }), line: { id: 'l1', name: 'L', order: [AWG] } });
    assert.deepEqual(r.order, [WG]);
    assert.equal(r.clamped, true);
    assert.notEqual(r.origin.scope, 'line');
  });

  it('can force a single method for the whole line', () => {
    const r = resolve({ organization: org(), line: { id: 'l1', name: 'L', order: [WSS, WG], forced: true } });
    assert.deepEqual(r.order, [WSS]);
    assert.equal(r.forced, true);
  });
});

describe('ADR 0037: device scope', () => {
  const line = { id: 'l1', name: 'Viaggiatori', order: [WG, WSS] };

  it('inherits from the line, then the organisation', () => {
    assert.equal(resolve({ organization: org(), line, device: { order: null } }).origin.scope, 'line');
    assert.equal(resolve({ organization: org(), device: { order: null } }).origin.scope, 'default');
  });

  it('has its own order inside what the line enables', () => {
    const r = resolve({ organization: org(), line, device: { id: 'd1', order: [WSS, WG] } });
    assert.deepEqual(r.order, [WSS, WG]);
    assert.deepEqual(r.origin, { scope: 'device', id: 'd1' });
  });

  it('cannot use a method its line does not enable', () => {
    const r = resolve({ organization: org(), line, device: { id: 'd1', order: [AWG, WSS] } });
    assert.deepEqual(r.order, [WSS]);
  });

  it('is forced to a single method', () => {
    const r = resolve({ organization: org(), line, device: { id: 'd1', order: [WSS, WG], forced: true } });
    assert.deepEqual(r.order, [WSS]);
    assert.equal(r.forced, true);
  });

  it('forces the first method that survives the bound, not a method the line forbids', () => {
    const r = resolve({ organization: org(), line, device: { id: 'd1', order: [AWG, WSS], forced: true } });
    assert.deepEqual(r.order, [WSS]);
  });

  it('a forced line bounds the device to that one method', () => {
    const r = resolve({
      organization: org(),
      line: { id: 'l1', name: 'L', order: [WSS, WG], forced: true },
      device: { id: 'd1', order: [WG, WSS] }
    });
    assert.deepEqual(r.order, [WSS]);
  });

  it('inherits and flags it when nothing of its order survives', () => {
    const r = resolve({
      organization: org(),
      line: { id: 'l1', name: 'L', order: [WG] },
      device: { id: 'd1', order: [AWG] }
    });
    assert.deepEqual(r.order, [WG]);
    assert.equal(r.clamped, true);
  });
});

describe('ADR 0037: person scope', () => {
  const person = { order: [WSS, WG] };

  it('does nothing unless the organisation lets members choose', () => {
    const r = resolve({ organization: org({ membersMayChoose: false }), person });
    assert.deepEqual(r.order, [WG, WSS, AWG]);
    assert.equal(r.personBlocked, 'not_enabled');
  });

  it('applies when members may choose', () => {
    const r = resolve({ organization: org({ membersMayChoose: true }), person });
    assert.deepEqual(r.order, [WSS, WG]);
    assert.equal(r.origin.scope, 'person');
    assert.equal(r.personBlocked, null);
  });

  it('can force a single method for the persons own devices', () => {
    const r = resolve({ organization: org({ membersMayChoose: true }), person: { order: [AWG, WG], forced: true } });
    assert.deepEqual(r.order, [AWG]);
    assert.equal(r.forced, true);
  });

  it('stays inside the line ceiling', () => {
    const r = resolve({
      organization: org({ membersMayChoose: true }),
      line: { id: 'l1', name: 'L', order: [WG, WSS] },
      person: { order: [AWG, WSS] }
    });
    assert.deepEqual(r.order, [WSS]);
  });

  it('stays inside the organisation ceiling', () => {
    const r = resolve({ organization: org({ membersMayChoose: true, allowed: [WG] }), person });
    assert.deepEqual(r.order, [WG]);
  });

  it('is prevented by a locked line', () => {
    const r = resolve({
      organization: org({ membersMayChoose: true }),
      line: { id: 'l1', name: 'L', order: [WG, WSS], locked: true },
      person
    });
    assert.deepEqual(r.order, [WG, WSS]);
    assert.equal(r.origin.scope, 'line');
    assert.equal(r.personBlocked, 'locked');
  });

  it('is prevented by a locked device', () => {
    const r = resolve({
      organization: org({ membersMayChoose: true }),
      device: { id: 'd1', order: [WG], locked: true },
      person
    });
    assert.deepEqual(r.order, [WG]);
    assert.equal(r.origin.scope, 'device');
    assert.equal(r.personBlocked, 'locked');
  });

  it('is prevented by a locked device that inherits', () => {
    const r = resolve({
      organization: org({ membersMayChoose: true }),
      device: { id: 'd1', order: null, locked: true },
      person
    });
    assert.deepEqual(r.order, [WG, WSS, AWG]);
    assert.equal(r.personBlocked, 'locked');
  });

  it('beats an unlocked administrator device setting', () => {
    const r = resolve({
      organization: org({ membersMayChoose: true }),
      device: { id: 'd1', order: [WG], locked: false },
      person
    });
    assert.deepEqual(r.order, [WSS, WG]);
    assert.equal(r.origin.scope, 'person');
  });

  it('yields to a device setting the owner made for that very device', () => {
    const r = resolve({
      organization: org({ membersMayChoose: true }),
      device: { id: 'd1', order: [WG], ownerSet: true },
      person
    });
    assert.deepEqual(r.order, [WG]);
    assert.equal(r.origin.scope, 'device');
  });

  it('with no person setting leaves the result alone', () => {
    const r = resolve({ organization: org({ membersMayChoose: true }), person: { order: null } });
    assert.equal(r.origin.scope, 'default');
    assert.equal(r.personBlocked, null);
  });
});

describe('ADR 0037: what the device gateway can run', () => {
  it('keeps only methods the gateway runs, in order', () => {
    const r = resolve({ organization: org(), available: [WG, AWG] });
    assert.deepEqual(r.order, [WG, AWG]);
    assert.equal(r.usable, true);
  });

  it('reports a device with no usable method', () => {
    const r = resolve({ organization: org({ order: [AWG], forced: true }), available: [WG, WSS] });
    assert.deepEqual(r.order, []);
    assert.equal(r.usable, false);
  });

  it('a forced method the gateway does not run is not replaced by the next one', () => {
    const r = resolve({ organization: org({ order: [AWG, WG], forced: true }), available: [WG] });
    assert.equal(r.usable, false);
  });

  it('is usable when no availability is given', () => {
    assert.equal(resolve({ organization: org() }).usable, true);
  });
});

describe('ADR 0037: validating an order before it is stored', () => {
  it('accepts a list of known methods without repeats', () => {
    assert.deepEqual(validateOrder([WSS, WG]), { ok: true, order: [WSS, WG] });
  });
  it('treats null as inherit', () => {
    assert.deepEqual(validateOrder(null), { ok: true, order: null });
  });
  it('refuses unknown, repeated, empty and non-list values', () => {
    for (const bad of [[], ['bogus'], [WG, WG], 'wireguard', [1], {}]) {
      assert.equal(validateOrder(bad).ok, false, JSON.stringify(bad));
    }
  });
  it('names reserved methods as not selectable yet', () => {
    for (const reserved of ['vless-reality', 'openvpn']) {
      const v = validateOrder([WG, reserved]);
      assert.equal(v.ok, false);
      assert.equal(v.code, 'method_reserved');
    }
  });
});

describe('ADR 0037: node-to-node link', () => {
  it('uses the first shared method when both ends agree', () => {
    const l = resolveLink({ a: [WG, WSS, AWG], b: [WG, WSS, AWG] });
    assert.equal(l.method, WG);
    assert.equal(l.no_path, false);
    assert.deepEqual(l.order, [WG, WSS, AWG]);
  });

  it('walks the more restrictive end (fewer methods)', () => {
    const l = resolveLink({ a: [WSS, WG], b: [WG, WSS, AWG] });
    assert.equal(l.method, WSS);
    assert.deepEqual(l.order, [WSS, WG]);
    assert.equal(l.restrictive, 'a');
  });

  it('is symmetric, including when both ends are equally restrictive', () => {
    const x = resolveLink({ a: [WG, WSS], b: [WSS, WG] });
    const y = resolveLink({ a: [WSS, WG], b: [WG, WSS] });
    assert.deepEqual(x.order, y.order);
    assert.equal(x.method, y.method);
    assert.equal(x.restrictive, 'tie');
    assert.equal(x.method, WG);
  });

  it('a forced end wins', () => {
    const l = resolveLink({ a: [WSS], b: [WG, WSS] });
    assert.equal(l.method, WSS);
  });

  it('is an explicit no_path when the ends share nothing', () => {
    const l = resolveLink({ a: [AWG], b: [WG, WSS] });
    assert.equal(l.no_path, true);
    assert.equal(l.method, null);
    assert.deepEqual(l.order, []);
  });

  it('is no_path when one end has no method at all', () => {
    assert.equal(resolveLink({ a: [], b: [WG] }).no_path, true);
    assert.equal(resolveLink({ a: [WG], b: [] }).no_path, true);
  });

  it('only uses methods the gateway and relays advertise', () => {
    const l = resolveLink({ a: [WSS, WG], b: [WSS, WG], advertised: [WG] });
    assert.equal(l.method, WG);
    assert.deepEqual(l.order, [WG]);
  });

  it('is no_path when nothing shared is advertised', () => {
    const l = resolveLink({ a: [WSS], b: [WSS, WG], advertised: [WG] });
    assert.equal(l.no_path, true);
  });
});
