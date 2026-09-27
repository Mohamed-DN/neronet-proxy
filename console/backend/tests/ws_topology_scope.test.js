const { describe, it } = require('node:test');
const assert = require('node:assert');
const { isVisibleTo } = require('../ws/topologyServer');

// The topology WebSocket sent every event without a user_id, and every relay and exit
// node event, to every connected user, whatever their organisation.

describe('Topology events reach only their organisation', () => {
  const superAdmin = { id: 'usr-root', role: 'super-admin', organization_id: 'org-default' };
  const alice = { id: 'usr-alice', role: 'user', organization_id: 'org-a', org_role: 'admin' };
  const mel = { id: 'usr-mel', role: 'user', organization_id: 'org-a', org_role: 'member' };

  it('lets the platform super-admin see everything', () => {
    assert.strictEqual(isVisibleTo(superAdmin, { event: 'X', organization_id: 'org-b' }), true);
    assert.strictEqual(isVisibleTo(superAdmin, { event: 'TOPOLOGY_ALL_RECONNECTED' }), true);
  });

  it("shows a user their own organisation's node events", () => {
    const event = { event: 'NODE_CREATE', organization_id: 'org-a', node: { id: 'n1', user_id: 'usr-bob' } };
    assert.strictEqual(isVisibleTo(alice, event), true);
  });

  it("hides another organisation's node events, relays and exits included", () => {
    for (const role of ['CLIENT_ORIGIN', 'RELAY', 'EXIT_BRIDGE']) {
      const event = { event: 'NODE_UPDATE', organization_id: 'org-b', node: { id: 'n2', role, user_id: 'usr-eve' } };
      assert.strictEqual(isVisibleTo(alice, event), false, role);
    }
  });

  it('hides events that name no organisation and no user of theirs', () => {
    assert.strictEqual(isVisibleTo(alice, { event: 'TOPOLOGY_LINK_CONFIG_UPDATED', source_node_id: 'n2' }), false);
    assert.strictEqual(isVisibleTo(alice, { event_type: 'USER_WIPED', payload: { user_id: 'usr-eve' } }), false);
  });

  it('shows events about their own account', () => {
    assert.strictEqual(isVisibleTo(alice, { event_type: 'USER_WIPED', payload: { user_id: 'usr-alice' } }), true);
  });

  it("shows a plain member their own nodes, not the rest of the organisation's", () => {
    const own = { event: 'NODE_UPDATE', organization_id: 'org-a', node: { id: 'n3', user_id: 'usr-mel' } };
    const colleague = { event: 'NODE_UPDATE', organization_id: 'org-a', node: { id: 'n4', user_id: 'usr-bob' } };
    assert.strictEqual(isVisibleTo(mel, own), true);
    assert.strictEqual(isVisibleTo(mel, colleague), false);
  });
});
