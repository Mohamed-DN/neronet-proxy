/**
 * The adapter the pages still call.
 *
 * WP-402 moved transport, authentication and caching into `apiClient` and the
 * query hooks beside it. The pages under src/components are redesigned one work
 * package at a time and have not moved yet, so this file stays as the shape
 * they expect: a namespace per resource, over `apiClient` and nothing else. It
 * shrinks to nothing as each page takes its hooks.
 *
 * What is gone from it is the fixtures. This file used to import 2,170 lines of
 * demo data, keep nine mutable arrays seeded from it, and answer a failed
 * request out of them: a console pointed at an unreachable control plane
 * displayed 120 invented devices, a busy 24-hour traffic ramp, a risk
 * distribution and an armed dead man's switch, none of which existed. All of it
 * shipped inside the production bundle.
 *
 * The two conventions the pages rely on are kept, deliberately:
 *
 * - a read that fails returns null, or an empty list where the caller expects
 *   one. A page cannot yet tell that from an empty answer, which is why the
 *   connection indicator exists and why the query hooks, which do distinguish
 *   them, are where each page is headed.
 * - a write that fails throws. It used to return null too, and twenty-three
 *   mutation methods answered by applying the change to a JavaScript object and
 *   reporting `{ success: true }`: quarantining a node, deleting a user,
 *   accepting a federation, arming the self-destruct. Nothing that changes
 *   state may report success it cannot account for.
 */

import { ApiError, apiRequest } from './apiClient';
import { parseFeatures } from './features.js';

/** A read. Returns null when the control plane did not answer. */
async function read(endpoint, options = {}) {
  try {
    return await apiRequest(endpoint, options);
  } catch (err) {
    if (err instanceof ApiError) return null;
    throw err;
  }
}

/** A write. Throws whatever went wrong, always. */
function write(endpoint, method, body) {
  return apiRequest(endpoint, body === undefined ? { method } : { method, body });
}

export const api = {
  // Which optional features the server has switched on. A failed request reads
  // as "all off", never as a fixture.
  features: {
    async get() {
      return parseFeatures(await read('/features'));
    }
  },

  nodes: {
    // Callers still pass a role filter. It is ignored, and the extra argument
    // is harmless: it used to filter the response down to rows whose user_id
    // was one of two fixture accounts, or whose role was RELAY, so a real
    // tenant saw an empty list and anyone's relays were visible to everyone.
    // /nodes is scoped to the caller by the server, which is where that
    // decision belongs.
    async list() {
      const live = await read('/nodes');
      if (Array.isArray(live?.nodes)) return live.nodes;
      return Array.isArray(live) ? live : [];
    },

    async get(id) {
      const live = await read(`/nodes/${encodeURIComponent(id)}`);
      return live?.node ?? null;
    },

    async action(id, actionType, params = {}) {
      return write(`/nodes/${encodeURIComponent(id)}/action`, 'POST', { action: actionType, params });
    }
  },

  users: {
    async list() {
      const live = await read('/users');
      return Array.isArray(live?.users) ? live.users : [];
    },

    async create(userData) {
      const live = await write('/users', 'POST', userData);
      if (!live?.user) throw new Error('The control plane did not return the created user');
      return live.user;
    },

    async update(id, updates) {
      const live = await write(`/users/${encodeURIComponent(id)}`, 'PATCH', updates);
      if (!live?.user) throw new Error('The control plane did not return the updated user');
      return live.user;
    },

    async delete(id) {
      return write(`/users/${encodeURIComponent(id)}`, 'DELETE');
    },

    async revokeSessions(id) {
      return write(`/users/${encodeURIComponent(id)}/revoke-sessions`, 'POST');
    },

    // The fallback here generated a Curve25519 private key in the browser,
    // wrote it into a WireGuard profile naming a relay endpoint that does not
    // exist, rendered it as a QR code and presented it as an onboarding
    // profile. A device that scanned it would have been configured against
    // nothing.
    async generateQrOnboarding(userId) {
      const live = await apiRequest(`/users/${encodeURIComponent(userId)}/onboard-qr`);
      if (!live?.qr_code_data_url) {
        throw new Error('The control plane did not return an onboarding profile');
      }
      return live;
    },

    async updateSplitTunneling(userId, bypassApps) {
      const live = await write(`/users/${encodeURIComponent(userId)}/split-tunneling`, 'PUT', {
        bypass_apps: bypassApps
      });
      if (!live?.user) throw new Error('The control plane did not return the updated user');
      return live.user;
    }
  },

  configs: {
    // As with the onboarding profile above: this used to mint keys in the
    // browser and hand back a complete profile, node identifier included, for a
    // node the control plane had never heard of.
    async generate(configParams) {
      const live = await write('/configs/generate', 'POST', configParams);
      if (!live?.wireguard_conf) {
        throw new Error('The control plane did not return a device profile');
      }
      return live;
    }
  },

  // These read the control plane and nothing else. They used to fall back to
  // fixtures - a constant 88.4 MB/s, a synthetic 24-hour ramp, and a
  // six-country matrix - so a console pointed at an empty or unreachable
  // backend still displayed a busy, healthy network.
  stats: {
    async getOverview() {
      return read('/stats/overview');
    },

    async getTimeseries(range = '24h') {
      const series = await read(`/stats/timeseries?range=${encodeURIComponent(range)}`);
      return Array.isArray(series) ? series : [];
    },

    async getGeoMatrix() {
      const matrix = await read('/stats/geo-matrix');
      return Array.isArray(matrix) ? matrix : [];
    },

    // Nodes plus the edges the ACL policy permits between them.
    async getTopology() {
      const t = await read('/stats/topology');
      return {
        nodes: Array.isArray(t?.nodes) ? t.nodes : [],
        links: Array.isArray(t?.links) ? t.links : [],
        policyIsOpen: Boolean(t?.policy_is_open),
        reachable: t !== null
      };
    }
  },

  // Two faults in one line, before this. The path was '/audit', where the
  // server mounts the stats router, so GET /api/audit answered with the
  // overview figures. The response was then read for `events`, which the audit
  // handler does not return either. Both misses fell through to a fixture, so
  // the forensic log displayed fabricated entries throughout the period when
  // the ledger was recording nothing at all.
  audit: {
    async list({ limit = 200 } = {}) {
      const live = await read(`/audit/events?limit=${encodeURIComponent(limit)}`);
      return Array.isArray(live?.audit_logs) ? live.audit_logs : [];
    }
  },

  // These three used to operate on a JavaScript array in this file. The engine
  // that compiles and delivers ACLs to the fleet was never contacted, so a rule
  // written in the console was gone on reload and never reached a node, while
  // the page showed it as active policy.
  acl: {
    async list() {
      const res = await read('/acl/rules');
      return {
        rules: Array.isArray(res?.rules) ? res.rules : [],
        epoch: res?.epoch ?? null,
        policyIsOpen: Boolean(res?.policy_is_open),
        reachable: res !== null
      };
    },

    async create(rule) {
      return write('/acl/rules', 'POST', rule);
    },

    async delete(id) {
      return write(`/acl/rules/${encodeURIComponent(id)}`, 'DELETE');
    },

    /** The policy a node will actually enforce, for confirming a rule landed. */
    async compiledFor(nodeId) {
      return read(`/acl/compiled/${encodeURIComponent(nodeId)}`);
    }
  },

  peering: {
    async list() {
      const live = await read('/peering');
      return Array.isArray(live?.agreements) ? live.agreements : [];
    },

    async create(data) {
      const live = await write('/peering', 'POST', data);
      if (!live?.agreement) throw new Error('The control plane did not return the agreement');
      return live.agreement;
    },

    async accept(id) {
      return write(`/peering/${encodeURIComponent(id)}/accept`, 'POST');
    },

    async revoke(id) {
      return write(`/peering/${encodeURIComponent(id)}/revoke`, 'POST');
    },

    // The fallback signed a peering token with random bytes and returned it as
    // a federation offer. A remote mesh handed that token would have rejected
    // it, after the operator had already sent it.
    async generateToken(params) {
      const live = await write('/peering/generate-token', 'POST', params);
      if (!live?.token) throw new Error('The control plane did not return a peering token');
      return live;
    }
  },

  // These three endpoints did not exist on the server, so each call 404ed and
  // returned the fixture below it: the risk page reported a distribution of
  // 14 low / 2 medium / 2 high and an average of 21.4 on any fleet.
  risk: {
    async getSummary() {
      return read('/risk/summary');
    },

    async listEvents() {
      const live = await read('/risk/events');
      return Array.isArray(live?.events) ? live.events : [];
    },

    async getLeaderboard() {
      const live = await read('/risk/leaderboard');
      return Array.isArray(live?.leaderboard) ? live.leaderboard : [];
    },

    async quarantine(nodeId, reason) {
      return api.nodes.action(nodeId, 'quarantine', { reason });
    },

    async clearRisk(nodeId) {
      return write(`/risk/nodes/${encodeURIComponent(nodeId)}/clear`, 'POST');
    }
  },

  geofencing: {
    // This returned fixtures whenever the live list was empty, so a deployment
    // with no geo policy configured displayed six countries of policy.
    async listPolicies() {
      const live = await read('/geofencing/policies');
      return Array.isArray(live?.policies) ? live.policies : [];
    },

    async updatePolicy(countryCode, action, egressAllowed = true) {
      const live = await write(`/geofencing/policies/${encodeURIComponent(countryCode)}`, 'PUT', {
        action,
        egress_allowed: egressAllowed
      });
      if (!live?.policy) throw new Error('The control plane did not confirm the policy');
      return live.policy;
    },

    async bulkUpdatePolicies(policies) {
      const live = await write('/geofencing/policies/bulk', 'POST', { policies });
      return Array.isArray(live?.policies) ? live.policies : [];
    }
  },

  cloudPc: {
    async list() {
      const live = await read('/cloud-pc');
      return Array.isArray(live?.instances) ? live.instances : [];
    },

    async project(id) {
      return write(`/cloud-pc/${encodeURIComponent(id)}/project`, 'POST');
    },

    async listCustomDomains() {
      const live = await read('/cloud-pc/custom-domains');
      return Array.isArray(live?.custom_domains) ? live.custom_domains : [];
    },

    async addCustomDomain(domainData) {
      const live = await write('/cloud-pc/custom-domains', 'POST', domainData);
      if (!live?.domain) throw new Error('The control plane did not return the domain');
      return live.domain;
    },

    async deleteCustomDomain(domain) {
      return write(`/cloud-pc/custom-domains/${encodeURIComponent(domain)}`, 'DELETE');
    },

    async verifyCustomDomain(domain) {
      return write(`/cloud-pc/custom-domains/${encodeURIComponent(domain)}/verify`, 'POST');
    }
  },

  // /nuke/state had no route. The 404 returned a fixture reporting a personal
  // dead man's switch armed on a 30-day interval, an owner switch pointed at a
  // Matrix webhook and a valid warrant canary, on a deployment where none of it
  // was configured. For a set of destructive controls, showing armed when
  // nothing is armed is the worst available failure.
  nuke: {
    async getGlobalState() {
      return read('/nuke/state');
    },

    // Tier 1: user account self-destruct, immediate.
    async userSelfDestruct(confirmationText, disclaimerAccepted) {
      if (confirmationText !== 'DELETE MY ACCOUNT' || !disclaimerAccepted) {
        throw new Error("Must accept disclaimer and type exact confirmation 'DELETE MY ACCOUNT'");
      }
      return write('/nuke/user/self-destruct', 'POST', {
        confirmation_text: confirmationText,
        disclaimer_accepted: disclaimerAccepted
      });
    },

    async scheduleSelfDestruct(scheduledAt) {
      return write('/nuke/user/schedule', 'POST', { scheduled_deletion_at: scheduledAt });
    },

    // Was '/nuke/user/schedule/cancel'; the route is '/nuke/user/cancel-scheduled'.
    // The 404 fell through to a fixture that cleared a local object and reported
    // the cancellation done, so a scheduled self-destruct the operator believed
    // they had called off was still scheduled.
    async cancelScheduledDestruct() {
      return write('/nuke/user/cancel-scheduled', 'POST');
    },

    // Tier 1b: per-user dead man's switch.
    async setupPersonalDms(passphrase, heartbeatIntervalSeconds, steganographyMode) {
      return write('/nuke/personal-dms/setup', 'POST', {
        passphrase,
        heartbeat_interval_seconds: heartbeatIntervalSeconds,
        steganography_mode: steganographyMode
      });
    },

    // The credential is verified by the server only. When the server cannot be
    // reached the switch stays locked; a client-side check would accept values
    // the server never saw.
    async verifyPersonalDmsSecret(method, credential) {
      const live = await read('/nuke/personal-dms/auth', {
        method: 'POST',
        body: { method, credential }
      });
      return live ?? { authenticated: false, dms_state: null, time_remaining_seconds: 0 };
    },

    async resetPersonalDmsHeartbeat(passphrase) {
      return write('/nuke/personal-dms/heartbeat', 'POST', { passphrase });
    },

    // Tier 2: network owner dead man's switch.
    async setupOwnerDms(passphrase, heartbeatIntervalSeconds, webhookUrl) {
      return write('/nuke/owner-dms/setup', 'POST', {
        passphrase,
        heartbeat_interval_seconds: heartbeatIntervalSeconds,
        webhook_url: webhookUrl
      });
    },

    async resetOwnerDmsHeartbeat(passphrase) {
      return write('/nuke/owner-dms/heartbeat', 'POST', { passphrase });
    },

    // Was '/nuke/owner-dms/trigger-wipe'; the route is '/nuke/owner-dms/trigger',
    // so this 404ed and the fixture below it emptied some arrays and reported
    // the wipe done. That fixture also assigned to an undeclared variable, which
    // would have thrown before it finished lying about what it had destroyed.
    async triggerOwnerWipe({ confirmationPhrase, password }) {
      return write('/nuke/owner-dms/trigger', 'POST', {
        confirmation_phrase: confirmationPhrase,
        password
      });
    },

    // Tier 3: warrant canary. Served as text from outside /api, so it does not
    // go through apiRequest. A canary that cannot be fetched is reported as
    // absent; the fixture that used to stand in for it declared the canary
    // valid, which is the one statement about a canary that must never be
    // invented.
    async getWarrantCanary() {
      try {
        const res = await fetch('/.well-known/canary.txt');
        if (!res.ok) return null;
        return await res.text();
      } catch {
        return null;
      }
    }
  }
};

export default api;
