/**
 * NeroNet Enterprise API Client & State Layer
 * Connects to the Control Plane Backend (/api) with automatic mock fallback.
 */

import QRCode from 'qrcode';
import { markReachable, markUnreachable, resolveList, resolveOne } from './dataSource.js';
import {
  MOCK_USERS,
  MOCK_NODES,
  MOCK_APP_BUNDLES,
  MOCK_AUDIT_LOGS,
  MOCK_TIMESERIES,
  MOCK_GEO_MATRIX,
  MOCK_ACL_RULES,
  MOCK_NERODROP_HISTORY,
  MOCK_PEERING_AGREEMENTS,
  MOCK_RISK_EVENTS,
  MOCK_GEOFENCING_POLICIES,
  MOCK_SOVEREIGN_CLOUD_PC,
  MOCK_CUSTOM_DOMAINS,
  MOCK_NERONUKE_CONFIG
} from './mockData.js';

// Mutable in-memory store for fallback mode with normalized node attributes
let inMemoryNodes = MOCK_NODES.map((n, index) => {
  const name = n.name || n.hostname || n.id;
  const overlay_ipv4 = n.overlay_ipv4 || n.mesh_ip || `100.64.0.${index + 1}`;
  const mesh_ip = n.mesh_ip || n.overlay_ipv4 || `100.64.0.${index + 1}`;
  const role = n.role === 'EDGE_CLIENT' ? 'CLIENT_ORIGIN' : n.role || 'CLIENT_ORIGIN';
  const is_quarantined = n.is_quarantined ? 1 : 0;
  const is_healthy = n.is_healthy !== undefined ? (n.is_healthy ? 1 : 0) : n.status === 'active' ? 1 : 0;
  const country_code = n.country_code || 'US';
  const city =
    n.city ||
    (country_code === 'US'
      ? 'Ashburn'
      : country_code === 'DE'
        ? 'Frankfurt'
        : country_code === 'GB'
          ? 'London'
          : country_code === 'FR'
            ? 'Paris'
            : country_code === 'NL'
              ? 'Amsterdam'
              : 'Regional');
  const asn =
    n.asn || (country_code === 'US' ? 7922 : country_code === 'DE' ? 3320 : country_code === 'GB' ? 5089 : 13335);

  return {
    id: n.id,
    user_id: n.user_id || 'usr-admin-001',
    name,
    hostname: n.hostname || name,
    overlay_ipv4,
    mesh_ip,
    overlay_ipv6: n.overlay_ipv6 || `fd7a:115c:a1e0::${index + 1}`,
    role,
    ip_class: n.ip_class || (role === 'RELAY' ? 'DATACENTER' : 'RESIDENTIAL'),
    country_code,
    city,
    asn,
    status: n.status || (is_healthy ? 'active' : 'offline'),
    is_healthy,
    is_quarantined,
    quarantine_reason: n.quarantine_reason || null,
    risk_score: n.risk_score || 0,
    risk_factors: n.risk_factors || [],
    latency_ms: n.latency_ms || (role === 'RELAY' ? 15.0 : 45.0),
    bandwidth_rx_mb_s: n.bandwidth_rx_mb_s || +(Math.random() * 200 + 20).toFixed(2),
    bandwidth_tx_mb_s: n.bandwidth_tx_mb_s || +(Math.random() * 150 + 15).toFixed(2),
    public_key: n.public_key || `K7lF8X${index + 100}+q32M4r1Z4w9v9G5e1bL3mN7oP9qR2sT4uV8w=`,
    preshared_key: n.preshared_key || `psk_${index + 100}_randomKey==`,
    endpoints: n.endpoints || [`${n.public_ip || '192.168.1.1'}:51820`],
    onion_routing_enabled: n.onion_routing_enabled ? 1 : 0,
    onion_hops: n.onion_hops || 0,
    kill_switch_enabled: n.kill_switch_enabled ? 1 : 0,
    cpu_usage_pct: n.cpu_usage_pct ?? +(10 + ((index * 7) % 30)).toFixed(1),
    memory_usage_pct: n.memory_usage_pct ?? +(20 + ((index * 11) % 40)).toFixed(1),
    battery_pct: n.battery_pct ?? (role === 'RELAY' ? 100 : 70 + ((index * 13) % 30)),
    os_type: n.os_type || (role === 'RELAY' ? 'linux' : ['macos', 'windows', 'linux', 'ios', 'android'][index % 5]),
    last_heartbeat: n.last_heartbeat || new Date().toISOString(),
    created_at: n.created_at || new Date().toISOString()
  };
});
let inMemoryUsers = [...MOCK_USERS];
let inMemoryApps = [...MOCK_APP_BUNDLES];
let inMemoryAuditLogs = [...MOCK_AUDIT_LOGS];
let inMemoryAclRules = [...MOCK_ACL_RULES];
let inMemoryNeroDropHistory = [...MOCK_NERODROP_HISTORY];
let inMemoryPeering = [...MOCK_PEERING_AGREEMENTS];
let inMemoryRiskEvents = [...MOCK_RISK_EVENTS];
let inMemoryGeoPolicies = [...MOCK_GEOFENCING_POLICIES];
let inMemoryCloudPc = [...MOCK_SOVEREIGN_CLOUD_PC];
let inMemoryCustomDomains = [...MOCK_CUSTOM_DOMAINS];
let inMemoryNukeConfig = JSON.parse(JSON.stringify(MOCK_NERONUKE_CONFIG));
let inMemoryShareLinks = [
  {
    id: 'shlink-seed-01',
    app_id: 'app-seed-guac',
    user_id: 'usr-admin',
    share_token: 'tok_guac_demo_clientless_rdp_2026',
    public_url:
      'https://workspace.neronet.darknero.com/#/clientless/app-seed-guac?token=tok_guac_demo_clientless_rdp_2026',
    auth_mode: 'temporary_password',
    temporary_password: 'SVRN-DEMO-2026',
    expires_at: new Date(Date.now() + 86400000 * 7).toISOString(),
    max_uses: 10,
    use_count: 1,
    is_revoked: false,
    is_expired: false,
    status: 'active',
    created_at: new Date().toISOString()
  }
];

const API_BASE = '/api';

const TOKEN_KEY = 'neronet_jwt_token';
const REFRESH_KEY = 'neronet_refresh_token';

function readStored(key) {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch (e) {
    return null;
  }
}

function writeStored(key, value) {
  try {
    if (typeof localStorage === 'undefined') return;
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch (e) {
    // Private browsing, or storage disabled. The session then lasts as long as the
    // tab, which is a degradation rather than a failure.
  }
}

function getAuthHeader() {
  const token = readStored(TOKEN_KEY);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Access tokens last fifteen minutes. A 401 used to delete the token and report the
// control plane as unreachable, so a console left open quietly logged itself out and
// showed every panel as failed, even though a refresh token was issued at sign-in
// and never stored. One refresh is attempted per expiry, shared between concurrent
// callers: the overview alone fires five requests at once, and each retrying
// independently would spend five refresh tokens on one expiry.
let refreshInFlight = null;

async function refreshAccessToken() {
  const refreshToken = readStored(REFRESH_KEY);
  if (!refreshToken) return null;

  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const res = await fetch(`${API_BASE}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken })
        });

        if (!res.ok) {
          // The refresh token is spent, revoked or expired. Clearing both is what
          // sends the user back to the sign-in screen.
          writeStored(TOKEN_KEY, null);
          writeStored(REFRESH_KEY, null);
          return null;
        }

        const body = await res.json();
        if (!body?.token) return null;

        writeStored(TOKEN_KEY, body.token);
        return body.token;
      } catch (e) {
        // A network failure is not proof the session ended, so the tokens are kept
        // and the next request tries again.
        return null;
      } finally {
        // Cleared on the next tick so callers awaiting this promise all observe the
        // same result before a new attempt can start.
        setTimeout(() => {
          refreshInFlight = null;
        }, 0);
      }
    })();
  }

  return refreshInFlight;
}

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isMutation(method) {
  return MUTATION_METHODS.has(String(method || 'GET').toUpperCase());
}

async function request(endpoint, options = {}, isRetry = false) {
  const url = `${API_BASE}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    ...getAuthHeader(),
    ...options.headers
  };

  try {
    const res = await fetch(url, { ...options, headers });
    if (!res.ok) {
      // Never on an /auth/ call: refreshing in response to a failed sign-in or a
      // failed refresh would loop.
      if (res.status === 401 && !isRetry && !endpoint.startsWith('/auth/')) {
        const fresh = await refreshAccessToken();
        if (fresh) return request(endpoint, options, true);
        writeStored(TOKEN_KEY, null);
      }

      const errorData = await res.json().catch(() => ({}));
      const err = new Error(errorData.error || `HTTP error ${res.status}`);
      err.status = res.status;
      err.data = errorData;
      throw err;
    }
    const body = await res.json();
    markReachable();
    return body;
  } catch (err) {
    if (endpoint.startsWith('/auth/')) {
      throw err;
    }

    markUnreachable(err?.message || 'control plane unreachable');

    // A read that fails returns null, which downstream treats as "the control plane
    // did not answer" — distinct from an empty list, which is a real answer an
    // operator needs to be able to see.
    //
    // A write that fails throws. It used to return null too, and twenty-three
    // mutation methods below responded by applying the change to a JavaScript
    // object and answering `{ success: true }`: quarantining a node, deleting a
    // user, accepting a federation, arming the self-destruct. The console reported
    // each as done while the control plane had never heard of it. Nothing that
    // changes state may report success it cannot account for, so the caller is made
    // to deal with the failure. The in-memory branches below are now unreachable.
    if (isMutation(options.method)) {
      throw err;
    }

    return null;
  }
}

// Generate realistic Curve25519 base64 keys
function generateRandomBase64Key() {
  const bytes = new Uint8Array(32);
  if (typeof window !== 'undefined' && window.crypto) {
    window.crypto.getRandomValues(bytes);
    // Curve25519 clamping
    bytes[0] &= 248;
    bytes[31] &= 127;
    bytes[31] |= 64;
  } else {
    for (let i = 0; i < 32; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export const api = {
  // Authentication
  auth: {
    async login(username, password) {
      const live = await request('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      });
      if (live && live.token) {
        writeStored(TOKEN_KEY, live.token);
        // Issued by the server since sign-in was built and dropped on the floor here,
        // which is why sessions ended after fifteen minutes.
        if (live.refreshToken) writeStored(REFRESH_KEY, live.refreshToken);
        return live;
      }
      throw new Error((live && live.error) || 'Invalid username or password');
    },

    async me() {
      const live = await request('/auth/me');
      if (live && live.user) return live.user;
      return null;
    },

    async logout() {
      try {
        await request('/auth/logout', { method: 'POST' });
      } catch (e) {
        // ignore logout network errors
      }
      // Both, or the refresh token outlives the session it belonged to and can be
      // exchanged for a working access token after the user signed out.
      writeStored(TOKEN_KEY, null);
      writeStored(REFRESH_KEY, null);
      return { success: true };
    }
  },

  // Nodes Management
  nodes: {
    // The roleFilter argument is accepted and ignored. It used to filter the
    // response down to rows whose user_id was one of two fixture accounts, or whose
    // role was RELAY — so a real tenant saw an empty list, and anyone's relays were
    // visible to everyone. /nodes is scoped to the caller by the server, which is
    // where that decision belongs. The parameter is kept so the five call sites do
    // not all have to change at once.
    async list(_roleFilter = null) {
      const live = await request('/nodes');
      if (live?.nodes && Array.isArray(live.nodes)) return live.nodes;
      return Array.isArray(live) ? live : [];
    },

    async get(id) {
      const live = await request(`/nodes/${id}`);
      return resolveOne(`/nodes/${id}`, live?.node ?? null, inMemoryNodes.find((n) => n.id === id) ?? null);
    },

    async action(id, actionType, params = {}) {
      const live = await request(`/nodes/${id}/action`, {
        method: 'POST',
        body: JSON.stringify({ action: actionType, params })
      });
      if (live) return live;

      // In-Memory state update
      const nodeIndex = inMemoryNodes.findIndex((n) => n.id === id);
      if (nodeIndex !== -1) {
        if (actionType === 'quarantine') {
          inMemoryNodes[nodeIndex] = {
            ...inMemoryNodes[nodeIndex],
            is_quarantined: 1,
            is_healthy: 0,
            quarantine_reason: params.reason || 'Manual Zero-Trust Security Isolation'
          };
          inMemoryAuditLogs.unshift({
            id: Date.now(),
            event_type: 'QUARANTINE_TRIGGER',
            severity: 'critical',
            actor_user_id: 'usr_admin_01',
            actor_username: 'admin',
            target_id: id,
            target_type: 'node',
            message: `Node '${inMemoryNodes[nodeIndex].name}' was quarantined by security admin`,
            ip_address: '100.64.0.1',
            user_agent: 'NeroNet-Console/4.0.0',
            metadata_json: JSON.stringify({ action: 'quarantine', reason: params.reason || 'Manual' }),
            created_at: new Date().toISOString()
          });
          return { success: true, message: 'Node quarantined successfully', node: inMemoryNodes[nodeIndex] };
        } else if (actionType === 'lift_quarantine') {
          inMemoryNodes[nodeIndex] = {
            ...inMemoryNodes[nodeIndex],
            is_quarantined: 0,
            is_healthy: 1,
            quarantine_reason: null
          };
          return { success: true, message: 'Quarantine lifted', node: inMemoryNodes[nodeIndex] };
        } else if (actionType === 'set_exit') {
          const currentRole = inMemoryNodes[nodeIndex].role;
          const newRole = currentRole === 'EXIT_BRIDGE' ? 'CLIENT_ORIGIN' : 'EXIT_BRIDGE';
          inMemoryNodes[nodeIndex] = {
            ...inMemoryNodes[nodeIndex],
            role: newRole
          };
          return { success: true, message: `Node role updated to ${newRole}`, node: inMemoryNodes[nodeIndex] };
        } else if (actionType === 'toggle_onion' || actionType === 'set_onion') {
          const currentOnion = Boolean(inMemoryNodes[nodeIndex].onion_routing_enabled);
          const newOnion = params.enabled !== undefined ? Boolean(params.enabled) : !currentOnion;
          inMemoryNodes[nodeIndex] = {
            ...inMemoryNodes[nodeIndex],
            onion_routing_enabled: newOnion ? 1 : 0,
            onion_hops: newOnion ? 3 : 0
          };
          return {
            success: true,
            onion_routing_enabled: newOnion,
            onion_hops: newOnion ? 3 : 0,
            node: inMemoryNodes[nodeIndex],
            result: {
              onion_routing_enabled: newOnion,
              onion_hops: newOnion ? 3 : 0
            }
          };
        } else if (actionType === 'toggle_kill_switch' || actionType === 'set_kill_switch') {
          const currentKillSwitch = Boolean(inMemoryNodes[nodeIndex].kill_switch_enabled);
          const newKillSwitch = params.enabled !== undefined ? Boolean(params.enabled) : !currentKillSwitch;
          inMemoryNodes[nodeIndex] = {
            ...inMemoryNodes[nodeIndex],
            kill_switch_enabled: newKillSwitch
          };
          return {
            success: true,
            kill_switch_enabled: newKillSwitch,
            node: inMemoryNodes[nodeIndex]
          };
        } else if (actionType === 'ping') {
          const baseLatency = inMemoryNodes[nodeIndex].latency_ms || 15.0;
          const jitter = +(Math.random() * 2.5).toFixed(2);
          const rtt = +(baseLatency + (Math.random() * 4 - 2)).toFixed(2);
          return {
            success: true,
            result: {
              rtt_ms: rtt,
              jitter_ms: jitter,
              packet_loss_pct: 0,
              min_ms: +(rtt - 1.2).toFixed(2),
              avg_ms: rtt,
              max_ms: +(rtt + 2.1).toFixed(2),
              status: inMemoryNodes[nodeIndex].is_quarantined ? 'unreachable' : 'active'
            }
          };
        } else if (actionType === 'revoke') {
          inMemoryNodes = inMemoryNodes.filter((n) => n.id !== id);
          return { success: true, message: 'Node revoked and removed from mesh' };
        }
      }
      return { success: false, error: 'Node not found' };
    }
  },

  // User Management
  users: {
    async list() {
      const live = await request('/users');
      return resolveList('/users', Array.isArray(live?.users) ? live.users : null, inMemoryUsers);
    },

    async create(userData) {
      const live = await request('/users', {
        method: 'POST',
        body: JSON.stringify(userData)
      });
      if (live && live.user) return live.user;

      const newUser = {
        id: `usr_${Math.random().toString(36).substring(2, 9)}`,
        username: userData.username,
        email: userData.email,
        role: userData.role || 'user',
        status: 'active',
        bandwidth_used_bytes: 0,
        max_nodes: Number(userData.max_nodes) || 5,
        bypass_apps: userData.bypass_apps || [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      inMemoryUsers.push(newUser);
      return newUser;
    },

    async update(id, updates) {
      const live = await request(`/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(updates)
      });
      if (live && live.user) return live.user;

      const idx = inMemoryUsers.findIndex((u) => u.id === id);
      if (idx !== -1) {
        inMemoryUsers[idx] = { ...inMemoryUsers[idx], ...updates, updated_at: new Date().toISOString() };
        return inMemoryUsers[idx];
      }
      throw new Error('User not found');
    },

    async delete(id) {
      const live = await request(`/users/${id}`, { method: 'DELETE' });
      if (live) return live;
      inMemoryUsers = inMemoryUsers.filter((u) => u.id !== id);
      return { success: true };
    },

    async revokeSessions(id) {
      const live = await request(`/users/${id}/revoke-sessions`, { method: 'POST' });
      return live || { success: true, message: 'All user refresh tokens revoked' };
    },

    async generateQrOnboarding(userId) {
      const live = await request(`/users/${userId}/onboard-qr`);
      if (live && live.qr_code_data_url) return live;

      const user = inMemoryUsers.find((u) => u.id === userId) || inMemoryUsers[0];
      const privateKey = generateRandomBase64Key();
      const serverPubKey = 'K7lF8X+q32M4r1Z4w9v9G5e1bL3mN7oP9qR2sT4uV8w=';
      const psk = generateRandomBase64Key();
      const randomOctet = Math.floor(Math.random() * 200) + 20;
      const overlayIp = `100.64.0.${randomOctet}`;

      const clientConfig = `# NeroNet Mobile Auto-Onboarding Profile
# User: ${user.username} (${user.id})
# Generated: ${new Date().toISOString()}

[Interface]
PrivateKey = ${privateKey}
Address = ${overlayIp}/32
DNS = 100.64.0.1, 1.1.1.1
MTU = 1380

[Peer]
PublicKey = ${serverPubKey}
PresharedKey = ${psk}
Endpoint = relay-iad-01.darknero.net:51820
AllowedIPs = 100.64.0.0/10, 0.0.0.0/0
PersistentKeepalive = 25
`;

      let qrCodeUrl = '';
      try {
        qrCodeUrl = await QRCode.toDataURL(clientConfig, {
          errorCorrectionLevel: 'M',
          margin: 2,
          color: {
            dark: '#38bdf8',
            light: '#0f172a'
          }
        });
      } catch (err) {
        qrCodeUrl =
          "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><rect fill='%230f172a' width='120' height='120'/><text fill='%2338bdf8' x='10' y='60'>QR Code</text></svg>";
      }

      return {
        user_id: user.id,
        username: user.username,
        overlay_ip: overlayIp,
        config_text: clientConfig,
        qr_code_data_url: qrCodeUrl
      };
    },

    async updateSplitTunneling(userId, bypassApps) {
      const live = await request(`/users/${userId}/split-tunneling`, {
        method: 'PUT',
        body: JSON.stringify({ bypass_apps: bypassApps })
      });
      if (live && live.user) return live.user;

      const idx = inMemoryUsers.findIndex((u) => u.id === userId);
      if (idx !== -1) {
        inMemoryUsers[idx] = {
          ...inMemoryUsers[idx],
          bypass_apps: bypassApps,
          updated_at: new Date().toISOString()
        };
        return inMemoryUsers[idx];
      }
      throw new Error('User not found');
    }
  },

  // App Bundles
  apps: {
    async list() {
      const live = await request('/apps');
      return resolveList('/apps', Array.isArray(live?.apps) ? live.apps : null, inMemoryApps);
    },

    async create(appData) {
      const live = await request('/apps', {
        method: 'POST',
        body: JSON.stringify(appData)
      });
      if (live && live.app) return live.app;

      const newApp = {
        id: `app_${appData.type}_${Math.random().toString(36).substring(2, 7)}`,
        user_id: appData.user_id || 'usr_admin_01',
        name: appData.name,
        type: appData.type,
        status: 'running',
        endpoint_url: `https://${appData.type}.internal.darknero.net`,
        internal_port: appData.type === 'guacamole' ? 8443 : appData.type === 'immich' ? 2283 : 8080,
        container_id: `cnt_neronet_${appData.type}_${Math.random().toString(36).substring(2, 6)}`,
        cpu_cores: Number(appData.cpu_cores) || 2.0,
        memory_mb: Number(appData.memory_mb) || 4096,
        storage_gb: Number(appData.storage_gb) || 100,
        scale_to_zero: appData.scale_to_zero ? 1 : 0,
        inactivity_timeout_min: Number(appData.inactivity_timeout_min) || 30,
        config_json: JSON.stringify(appData.config || {}),
        last_accessed_at: new Date().toISOString(),
        created_at: new Date().toISOString()
      };
      inMemoryApps.push(newApp);
      return newApp;
    },

    async action(id, actionType) {
      const live = await request(`/apps/${id}/action`, {
        method: 'POST',
        body: JSON.stringify({ action: actionType })
      });
      if (live) return live;

      const idx = inMemoryApps.findIndex((a) => a.id === id);
      if (idx !== -1) {
        if (actionType === 'start') {
          inMemoryApps[idx].status = 'running';
          inMemoryApps[idx].last_accessed_at = new Date().toISOString();
        } else if (actionType === 'stop') {
          inMemoryApps[idx].status = 'stopped';
        } else if (actionType === 'scale_to_zero') {
          inMemoryApps[idx].scale_to_zero = inMemoryApps[idx].scale_to_zero ? 0 : 1;
        }
        return { success: true, app: inMemoryApps[idx] };
      }
      return { success: false, error: 'App not found' };
    },

    async launch(id) {
      const live = await request(`/apps/${id}/launch`);
      if (live) return live;

      const app = inMemoryApps.find((a) => a.id === id);
      const ssoToken = `sso_neronet_${Math.random().toString(36).substring(2, 15)}`;
      return {
        launch_url: app ? `${app.endpoint_url}?sso_token=${ssoToken}` : 'https://guac.internal.darknero.net',
        sso_token: ssoToken,
        app_name: app?.name || 'Sovereign Service'
      };
    },

    async listShareLinks(appId) {
      const live = await request(`/apps/${appId}/share-links`);
      if (live && live.share_links) return live.share_links;
      return inMemoryShareLinks.filter((l) => l.app_id === appId);
    },

    async createShareLink(appId, shareData) {
      const live = await request(`/apps/${appId}/share`, {
        method: 'POST',
        body: JSON.stringify(shareData)
      });
      if (live && (live.share_link || live.link)) return live.share_link || live.link;

      const newLink = {
        id: `shlink-${Math.random().toString(36).substring(2, 10)}`,
        app_id: appId,
        user_id: 'usr_admin_01',
        share_token: `tok_pub_${Math.random().toString(36).substring(2, 15)}`,
        public_url: `https://workspace.neronet.darknero.com/#/clientless/${appId}?token=tok_pub_${Math.random().toString(36).substring(2, 15)}`,
        auth_mode: shareData.auth_mode || 'temporary_password',
        temporary_password:
          shareData.auth_mode === 'temporary_password'
            ? shareData.temporary_password || `SVRN-${Math.random().toString(36).substring(2, 6).toUpperCase()}`
            : null,
        expires_at:
          shareData.expires_at ||
          new Date(Date.now() + (Number(shareData.expires_in_hours) || 24) * 3600 * 1000).toISOString(),
        max_uses: Number(shareData.max_uses) || 0,
        use_count: 0,
        is_revoked: false,
        is_expired: false,
        status: 'active',
        created_at: new Date().toISOString()
      };
      inMemoryShareLinks.unshift(newLink);
      return newLink;
    },

    async revokeShareLink(appId, linkId) {
      const live = await request(`/apps/${appId}/share-links/${linkId}`, {
        method: 'DELETE'
      });
      if (live) return live;

      const idx = inMemoryShareLinks.findIndex((l) => l.id === linkId);
      if (idx !== -1) {
        inMemoryShareLinks[idx].is_revoked = true;
        inMemoryShareLinks[idx].status = 'revoked';
        return { success: true, message: 'Share link revoked successfully' };
      }
      return { success: false, error: 'Share link not found' };
    },

    async verifyPublicShareLink(token) {
      const live = await request(`/apps/public/verify/${token}`);
      if (live) return live;

      const link = inMemoryShareLinks.find((l) => l.share_token === token);
      if (!link) return { valid: false, error: 'Share link not found' };
      if (link.is_revoked) return { valid: false, error: 'Share link is revoked', is_revoked: true };
      link.use_count += 1;
      return {
        valid: true,
        share_id: link.id,
        app_id: link.app_id,
        app_name: 'Guacamole Bastion',
        app_type: 'guacamole',
        auth_mode: link.auth_mode,
        public_url: link.public_url,
        gateway_protocol: 'guacamole_clientless_rdp',
        websocket_endpoint: `wss://workspace.neronet.darknero.com/guac-tunnel/${link.app_id}`,
        session_token: `sess_pub_${Math.random().toString(36).substring(2, 12)}`,
        expires_at: link.expires_at,
        use_count: link.use_count,
        max_uses: link.max_uses,
        requires_password: link.auth_mode === 'temporary_password'
      };
    }
  },

  // Crypto & Config Generator
  configs: {
    async generate(configParams) {
      const live = await request('/configs/generate', {
        method: 'POST',
        body: JSON.stringify(configParams)
      });
      if (live && live.wireguard_conf) return live;

      // Real in-browser cryptographic calculation
      const privateKey = generateRandomBase64Key();
      const publicKey = generateRandomBase64Key();
      const psk = generateRandomBase64Key();
      const randomOctet = Math.floor(Math.random() * 200) + 20;
      const ipv4 = `100.64.0.${randomOctet}`;
      const ipv6 = `fd7a:115c:a1e0::${randomOctet}`;
      const serverEndpoint = 'relay-iad-01.darknero.net:51820';
      const serverPubKey = 'K7lF8X+q32M4r1Z4w9v9G5e1bL3mN7oP9qR2sT4uV8w=';
      const onionEnabled = Boolean(configParams.onion_routing_enabled || Number(configParams.onion_hops) > 0);
      const onionHops = onionEnabled ? Number(configParams.onion_hops) || 3 : 0;

      const wireguardConf = `# =========================================================
# NeroNet Sovereign Mesh DirectFrame v4.0 WireGuard Profile
# Device: ${configParams.name || 'New-Device'}
# Role: ${configParams.role || 'CLIENT_ORIGIN'} | IP Class: ${configParams.ip_class || 'RESIDENTIAL'}
# Onion Obfuscation: ${onionEnabled ? '3-Hop Multi-Route' : 'Direct (0-Hop)'}
# Generated: ${new Date().toUTCString()}
# =========================================================

[Interface]
PrivateKey = ${privateKey}
Address = ${ipv4}/32, ${ipv6}/128
DNS = 100.64.0.1, 1.1.1.1
MTU = 1380

[Peer]
PublicKey = ${serverPubKey}
PresharedKey = ${psk}
Endpoint = ${serverEndpoint}
AllowedIPs = 100.64.0.0/10, fd7a:115c:a1e0::/48, 0.0.0.0/0, ::/0
PersistentKeepalive = 25
`;

      const jsonProfile = {
        version: '4.0.0',
        schema: 'neronet_directframe_v4',
        identity: {
          node_id: `svrn-node-${Math.random().toString(36).substring(2, 9)}`,
          name: configParams.name || 'New-Device',
          role: configParams.role || 'CLIENT_ORIGIN',
          country_code: configParams.country_code || 'US'
        },
        network: {
          overlay_ipv4: ipv4,
          overlay_ipv6: ipv6,
          dns_servers: ['100.64.0.1', '1.1.1.1'],
          mtu: 1380,
          keepalive_interval_sec: 25
        },
        crypto: {
          handshake_protocol: 'Noise_IKpsk2_25519_ChaChaPoly_BLAKE2s',
          curve: 'Curve25519',
          cipher: 'ChaCha20-Poly1305',
          hash: 'BLAKE2s',
          clamped_public_key: publicKey,
          preshared_key: psk
        },
        relays: [
          {
            name: 'neronet-relay-iad-01',
            endpoint: serverEndpoint,
            public_key: serverPubKey
          }
        ],
        routing: {
          egress_mode: configParams.role || 'CLIENT_ORIGIN',
          preferred_countries: configParams.country_code ? [configParams.country_code, 'US', 'DE'] : ['US', 'DE', 'CH'],
          onion_hops: onionHops,
          onion_routing_enabled: onionEnabled
        }
      };

      // Generate Base64 QR Code using QRCode library
      let qrCodeUrl = '';
      try {
        qrCodeUrl = await QRCode.toDataURL(wireguardConf, {
          errorCorrectionLevel: 'M',
          margin: 2,
          color: {
            dark: '#06b6d4',
            light: '#09090b'
          }
        });
      } catch (err) {
        qrCodeUrl =
          "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'><rect fill='%23000' width='100' height='100'/><text fill='%23fff' x='10' y='50'>QR Code</text></svg>";
      }

      // Add to in-memory nodes list
      const newNode = {
        id: jsonProfile.identity.node_id,
        user_id: 'usr_admin_01',
        name: configParams.name || 'New-Device',
        public_key: publicKey,
        preshared_key: psk,
        overlay_ipv4: ipv4,
        overlay_ipv6: ipv6,
        role: configParams.role || 'CLIENT_ORIGIN',
        ip_class: configParams.ip_class || 'RESIDENTIAL',
        country_code: configParams.country_code || 'US',
        city: configParams.city || 'San Francisco',
        asn: 7922,
        endpoints: [`192.168.1.${randomOctet}:51820`],
        onion_routing_enabled: onionEnabled ? 1 : 0,
        onion_hops: onionHops,
        is_healthy: 1,
        is_quarantined: 0,
        quarantine_reason: null,
        last_heartbeat: new Date().toISOString(),
        latency_ms: onionEnabled ? 48.4 : 18.4,
        tx_bytes: 0,
        rx_bytes: 0,
        cpu_usage_pct: 12.0,
        memory_usage_pct: 35.0,
        battery_pct: 100.0,
        os_type: configParams.os_type || 'macos',
        created_at: new Date().toISOString()
      };
      inMemoryNodes.push(newNode);

      return {
        node_id: jsonProfile.identity.node_id,
        node: newNode,
        private_key: privateKey,
        public_key: publicKey,
        preshared_key: psk,
        overlay_ipv4: ipv4,
        overlay_ipv6: ipv6,
        onion_routing_enabled: onionEnabled,
        onion_hops: onionHops,
        wireguard_conf: wireguardConf,
        json_profile: jsonProfile,
        qrcode_data_url: qrCodeUrl
      };
    }
  },

  // NeroDrop P2P File Transfer
  nerodrop: {
    async createSession(sessionData) {
      const live = await request('/nerodrop/session', {
        method: 'POST',
        body: JSON.stringify(sessionData)
      });
      if (live) return live;

      const sessionId = `drop_${Math.random().toString(36).substring(2, 10)}`;
      const chunkSize = 65536; // 64KB chunks
      const totalChunks = Math.ceil(sessionData.file_size_bytes / chunkSize);

      return {
        session_id: sessionId,
        status: 'ready',
        chunk_size_bytes: chunkSize,
        total_chunks: totalChunks,
        blake3_hash: sessionData.blake3_hash,
        webrtc_signal: {
          sdp_type: 'offer',
          dtls_fingerprint: 'SHA-256 89:3B:4E:...:9A',
          ice_candidates: ['candidate:1 1 UDP 2130706431 100.64.0.10 54321 typ host']
        }
      };
    },

    async listHistory() {
      return inMemoryNeroDropHistory;
    },

    async recordTransfer(transfer) {
      inMemoryNeroDropHistory.unshift(transfer);
      inMemoryAuditLogs.unshift({
        id: Date.now(),
        event_type: 'NERODROP_SESSION',
        severity: 'info',
        actor_user_id: 'usr_alice_01',
        actor_username: 'alice_dev',
        target_id: transfer.target_node_name,
        target_type: 'file_transfer',
        message: `P2P NeroDrop completed: '${transfer.file_name}' (${(transfer.file_size_bytes / 1024 / 1024).toFixed(2)} MB)`,
        ip_address: '100.64.0.10',
        user_agent: 'NeroNet-Client/4.0.0',
        metadata_json: JSON.stringify(transfer),
        created_at: new Date().toISOString()
      });
      return { success: true };
    }
  },

  // Analytics & Stats
  //
  // These three read the control plane and nothing else. They used to fall back to
  // fixtures — a constant 88.4 MB/s, a synthetic 24-hour ramp, and a six-country
  // matrix — which meant a console pointed at an empty or unreachable backend still
  // displayed a busy, healthy network. An empty result is now returned as empty and
  // rendered as such.
  stats: {
    async getOverview() {
      return request('/stats/overview');
    },

    async getTimeseries(range = '24h') {
      const series = await request(`/stats/timeseries?range=${encodeURIComponent(range)}`);
      return Array.isArray(series) ? series : [];
    },

    async getGeoMatrix() {
      const matrix = await request('/stats/geo-matrix');
      return Array.isArray(matrix) ? matrix : [];
    },

    // Nodes plus the edges the ACL policy permits between them.
    async getTopology() {
      const t = await request('/stats/topology');
      return {
        nodes: Array.isArray(t?.nodes) ? t.nodes : [],
        links: Array.isArray(t?.links) ? t.links : [],
        policyIsOpen: Boolean(t?.policy_is_open),
        reachable: t !== null
      };
    }
  },

  // Forensic Audit Logs
  //
  // Two faults in one line. The path was '/audit', and the server mounts the stats
  // router there, so GET /api/audit answered with the overview figures — active
  // nodes, total nodes, connected users. The response was then read for `events`,
  // which the audit handler does not return either; it returns `audit_logs`. Both
  // misses fell through to a fixture, so the forensic log displayed fabricated
  // entries, and went on displaying them throughout the period when the ledger was
  // recording nothing at all.
  audit: {
    async list({ limit = 200 } = {}) {
      const live = await request(`/audit/events?limit=${encodeURIComponent(limit)}`);
      return Array.isArray(live?.audit_logs) ? live.audit_logs : [];
    }
  },

  // ACL & Settings
  // These three used to operate on a JavaScript array in this file. The engine that
  // compiles and delivers ACLs to the fleet was never contacted, so a rule written
  // in the console was gone on reload and never reached a node, while the page
  // showed it as active policy.
  acl: {
    async list() {
      const res = await request('/acl/rules');
      return {
        rules: Array.isArray(res?.rules) ? res.rules : [],
        epoch: res?.epoch ?? null,
        policyIsOpen: Boolean(res?.policy_is_open),
        reachable: res !== null
      };
    },

    async create(rule) {
      const res = await request('/acl/rules', {
        method: 'POST',
        body: JSON.stringify(rule)
      });
      if (!res) throw new Error('The control plane did not accept the rule');
      return res;
    },

    async delete(id) {
      const res = await request(`/acl/rules/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res) throw new Error('The control plane did not confirm the deletion');
      return res;
    },

    /** The policy a node will actually enforce, for confirming a rule landed. */
    async compiledFor(nodeId) {
      return request(`/acl/compiled/${encodeURIComponent(nodeId)}`);
    }
  },

  // Cross-Mesh Peering Management
  peering: {
    async list() {
      const live = await request('/peering');
      return resolveList('/peering', Array.isArray(live?.agreements) ? live.agreements : null, inMemoryPeering);
    },

    async create(data) {
      const live = await request('/peering', {
        method: 'POST',
        body: JSON.stringify(data)
      });
      if (live && live.agreement) return live.agreement;

      const newAg = {
        id: `peer_ag_${Math.random().toString(36).substring(2, 7)}`,
        remote_mesh_name: data.remote_mesh_name || 'Custom-Peer-Mesh',
        remote_endpoint: data.remote_endpoint,
        remote_public_key: data.remote_public_key || `ed25519_${Math.random().toString(36).substring(2, 20)}`,
        scope_mode: data.scope_mode || 'ALL',
        shared_subnets: data.shared_subnets || ['100.64.0.0/16'],
        shared_devices_count: data.shared_devices_count || 1,
        latency_ms: +(15 + Math.random() * 25).toFixed(1),
        status: 'active',
        expires_at: data.expires_at || new Date(Date.now() + 30 * 86400000).toISOString(),
        created_at: new Date().toISOString()
      };
      inMemoryPeering.unshift(newAg);
      return newAg;
    },

    async accept(id) {
      const live = await request(`/peering/${id}/accept`, { method: 'POST' });
      if (live) return live;

      const idx = inMemoryPeering.findIndex((p) => p.id === id);
      if (idx !== -1) {
        inMemoryPeering[idx] = { ...inMemoryPeering[idx], status: 'active' };
        return { success: true, agreement: inMemoryPeering[idx] };
      }
      return { success: false, error: 'Agreement not found' };
    },

    async revoke(id) {
      const live = await request(`/peering/${id}/revoke`, { method: 'POST' });
      if (live) return live;

      const idx = inMemoryPeering.findIndex((p) => p.id === id);
      if (idx !== -1) {
        inMemoryPeering[idx] = { ...inMemoryPeering[idx], status: 'revoked' };
        return { success: true, agreement: inMemoryPeering[idx] };
      }
      return { success: false, error: 'Agreement not found' };
    },

    async generateToken(params) {
      const live = await request('/peering/generate-token', {
        method: 'POST',
        body: JSON.stringify(params)
      });
      if (live && live.token) return live;

      const tokenPayload = {
        version: '1.0',
        peering_id: `peer_req_${Math.random().toString(36).substring(2, 9)}`,
        initiator_endpoint: 'https://console.neronet.darknero.com',
        initiator_public_key: generateRandomBase64Key(),
        scope_mode: params.scope_mode || 'ALL',
        shared_device_ids: params.shared_device_ids || [],
        shared_subnets: params.shared_subnets || ['100.64.0.0/16'],
        expires_at: params.expires_at || new Date(Date.now() + 7 * 86400000).toISOString(),
        signature: generateRandomBase64Key() + generateRandomBase64Key()
      };

      return {
        token: btoa(JSON.stringify(tokenPayload)),
        payload: tokenPayload
      };
    }
  },

  // Behavioral Risk Dashboard & Anomaly Engine
  risk: {
    // These three endpoints did not exist on the server, so each call 404ed and
    // returned the fixture below it: the risk page reported a distribution of
    // 14 low / 2 medium / 2 high and an average of 21.4 on any fleet. They exist
    // now and the fixtures are gone.
    async getSummary() {
      return request('/risk/summary');
    },

    async listEvents() {
      const live = await request('/risk/events');
      return Array.isArray(live?.events) ? live.events : [];
    },

    async getLeaderboard() {
      const live = await request('/risk/leaderboard');
      return Array.isArray(live?.leaderboard) ? live.leaderboard : [];
    },

    async quarantine(nodeId, reason) {
      const res = await api.nodes.action(nodeId, 'quarantine', { reason });
      const nodeIndex = inMemoryNodes.findIndex((n) => n.id === nodeId);
      if (nodeIndex !== -1) {
        inMemoryNodes[nodeIndex].risk_score = Math.max(80, inMemoryNodes[nodeIndex].risk_score || 85);
      }
      return res;
    },

    async clearRisk(nodeId) {
      const live = await request(`/risk/nodes/${nodeId}/clear`, { method: 'POST' });
      if (live) return live;

      const nodeIndex = inMemoryNodes.findIndex((n) => n.id === nodeId);
      if (nodeIndex !== -1) {
        inMemoryNodes[nodeIndex] = {
          ...inMemoryNodes[nodeIndex],
          risk_score: 10,
          risk_factors: [],
          is_quarantined: 0,
          is_healthy: 1,
          quarantine_reason: null
        };
        inMemoryRiskEvents = inMemoryRiskEvents.filter((e) => e.node_id !== nodeId);
        return { success: true, node: inMemoryNodes[nodeIndex] };
      }
      return { success: false, error: 'Node not found' };
    }
  },

  // Geo-Fencing Policy Engine (PostGIS)
  geofencing: {
    async listPolicies() {
      const live = await request('/geofencing/policies');
      if (live?.policies && Array.isArray(live.policies) && live.policies.length > 0) return live.policies;
      return inMemoryGeoPolicies.map((p) => ({
        ...p,
        node_count: inMemoryNodes.filter((n) => n.country_code === p.country_code).length
      }));
    },

    async updatePolicy(countryCode, action, egressAllowed = true) {
      const live = await request(`/geofencing/policies/${countryCode}`, {
        method: 'PUT',
        body: JSON.stringify({ action, egress_allowed: egressAllowed })
      });
      if (live && live.policy) return live.policy;

      const idx = inMemoryGeoPolicies.findIndex((p) => p.country_code === countryCode);
      if (idx !== -1) {
        inMemoryGeoPolicies[idx] = {
          ...inMemoryGeoPolicies[idx],
          action,
          egress_allowed: egressAllowed,
          updated_at: new Date().toISOString()
        };
        return inMemoryGeoPolicies[idx];
      }
      const newPol = {
        country_code: countryCode,
        country_name: countryCode,
        action,
        node_count: inMemoryNodes.filter((n) => n.country_code === countryCode).length,
        egress_allowed: egressAllowed,
        updated_at: new Date().toISOString()
      };
      inMemoryGeoPolicies.push(newPol);
      return newPol;
    },

    async bulkUpdatePolicies(policies) {
      const live = await request('/geofencing/policies/bulk', {
        method: 'POST',
        body: JSON.stringify({ policies })
      });
      if (live && live.policies) return live.policies;

      policies.forEach((p) => {
        const idx = inMemoryGeoPolicies.findIndex((g) => g.country_code === p.country_code);
        if (idx !== -1) {
          inMemoryGeoPolicies[idx] = { ...inMemoryGeoPolicies[idx], ...p, updated_at: new Date().toISOString() };
        } else {
          inMemoryGeoPolicies.push({ ...p, updated_at: new Date().toISOString() });
        }
      });
      return inMemoryGeoPolicies;
    }
  },

  // Sovereign Cloud PC (WebRTC Native / Selkies-GStreamer & Custom Domains)
  cloudPc: {
    async list() {
      const live = await request('/cloud-pc');
      return resolveList('/cloud-pc', Array.isArray(live?.instances) ? live.instances : null, inMemoryCloudPc);
    },

    async project(id) {
      const live = await request(`/cloud-pc/${id}/project`, { method: 'POST' });
      if (live) return live;

      const instance = inMemoryCloudPc.find((c) => c.id === id) || inMemoryCloudPc[0];
      const streamToken = `stream_tok_${Math.random().toString(36).substring(2, 16)}`;
      return {
        session_id: `sess_webrtc_${Math.random().toString(36).substring(2, 10)}`,
        cpc_id: instance.id,
        cpc_name: instance.name,
        signaling_url: instance.webrtc_signaling_url,
        ice_servers: instance.stun_turn_servers,
        stream_token: streamToken,
        viewer_url: `https://workspace.neronet.darknero.com/webrtc-viewer?stream_token=${streamToken}&cpc=${instance.id}`,
        fps: instance.fps,
        resolution: instance.resolution,
        codec: instance.codec
      };
    },

    async listCustomDomains() {
      const live = await request('/cloud-pc/custom-domains');
      return resolveList(
        '/custom-domains',
        Array.isArray(live?.custom_domains) ? live.custom_domains : null,
        inMemoryCustomDomains
      );
    },

    async addCustomDomain(domainData) {
      const live = await request('/cloud-pc/custom-domains', {
        method: 'POST',
        body: JSON.stringify(domainData)
      });
      if (live && live.domain) return live.domain;

      const newDom = {
        domain: domainData.domain,
        cpc_id: domainData.cpc_id,
        cpc_name: domainData.cpc_name || 'Sovereign Cloud PC',
        dns_status: 'verified',
        ssl_status: 'active',
        sso_enforced: domainData.sso_enforced ?? true,
        otp_gateway_required: domainData.otp_gateway_required ?? true,
        cname_target: 'cpc-ingress.neronet.darknero.com',
        created_at: new Date().toISOString()
      };
      inMemoryCustomDomains.unshift(newDom);
      return newDom;
    },

    async deleteCustomDomain(domain) {
      const live = await request(`/cloud-pc/custom-domains/${domain}`, { method: 'DELETE' });
      if (live) return live;
      inMemoryCustomDomains = inMemoryCustomDomains.filter((d) => d.domain !== domain);
      return { success: true };
    },

    async verifyCustomDomain(domain) {
      const live = await request(`/cloud-pc/custom-domains/${domain}/verify`, { method: 'POST' });
      if (live) return live;
      const item = inMemoryCustomDomains.find((d) => d.domain === domain);
      if (item) item.dns_status = 'verified';
      return { verified: true, ssl_status: 'active' };
    }
  },

  // NeroNuke 3-Tier Dead Man's Switch & Self-Destruct System
  nuke: {
    // /nuke/state had no route. The 404 returned the fixture below, which reported
    // a personal dead man's switch armed on a 30-day interval, an owner switch
    // pointed at a Matrix webhook and a valid warrant canary — on a deployment
    // where none of it was configured. For a set of destructive controls, showing
    // armed when nothing is armed is the worst available failure.
    async getGlobalState() {
      return request('/nuke/state');
    },

    // Tier 1: User Account Self-Destruct (Immediate)
    async userSelfDestruct(confirmationText, disclaimerAccepted) {
      if (confirmationText !== 'DELETE MY ACCOUNT' || !disclaimerAccepted) {
        throw new Error("Must accept disclaimer and type exact confirmation 'DELETE MY ACCOUNT'");
      }
      const live = await request('/nuke/user/self-destruct', {
        method: 'POST',
        body: JSON.stringify({ confirmation_text: confirmationText, disclaimer_accepted: disclaimerAccepted })
      });
      if (live) return live;

      // In-Memory destruction
      inMemoryNodes = inMemoryNodes.filter((n) => n.user_id !== 'usr_alice_01');
      inMemoryUsers = inMemoryUsers.filter((u) => u.id !== 'usr_alice_01');
      return {
        success: true,
        message: 'Account and personal keys hard-deleted. Cryptographic wipe executed.'
      };
    },

    // Tier 1: User Scheduled Self-Destruct
    async scheduleSelfDestruct(scheduledAt) {
      const live = await request('/nuke/user/schedule', {
        method: 'POST',
        body: JSON.stringify({ scheduled_deletion_at: scheduledAt })
      });
      if (live) return live;

      inMemoryNukeConfig.tier1_scheduled_kill = {
        armed: true,
        scheduled_at: scheduledAt,
        phrase: 'DELETE MY ACCOUNT'
      };
      return inMemoryNukeConfig.tier1_scheduled_kill;
    },

    async cancelScheduledDestruct() {
      // Was '/nuke/user/schedule/cancel'; the route is '/nuke/user/cancel-scheduled'.
      // The 404 fell through to a fixture that cleared a local object and reported
      // the cancellation done, so a scheduled self-destruct the operator believed
      // they had called off was still scheduled.
      const live = await request('/nuke/user/cancel-scheduled', { method: 'POST' });
      if (live) return live;

      inMemoryNukeConfig.tier1_scheduled_kill = {
        armed: false,
        scheduled_at: null,
        phrase: 'DELETE MY ACCOUNT'
      };
      return { success: true };
    },

    // Tier 1b: Per-User Dead Man's Switch (Steganographic Hidden Mode)
    async setupPersonalDms(passphrase, heartbeatIntervalSeconds, steganographyMode) {
      const live = await request('/nuke/personal-dms/setup', {
        method: 'POST',
        body: JSON.stringify({
          passphrase,
          heartbeat_interval_seconds: heartbeatIntervalSeconds,
          steganography_mode: steganographyMode
        })
      });
      if (live) return live;

      inMemoryNukeConfig.tier1b_personal_dms = {
        armed: true,
        heartbeat_interval_seconds: Number(heartbeatIntervalSeconds),
        last_heartbeat_at: new Date().toISOString(),
        steganography_mode: steganographyMode
      };
      return inMemoryNukeConfig.tier1b_personal_dms;
    },

    async verifyPersonalDmsSecret(method, credential) {
      const live = await request('/nuke/personal-dms/auth', {
        method: 'POST',
        body: JSON.stringify({ method, credential })
      });
      if (live) return live;

      // Realistic mock validation of 5 steganographic methods
      let isValid = false;
      if (method === 'reverse_password' && credential && credential.length >= 3) isValid = true;
      else if (method === 'split_reverse' && credential && credential.length >= 3) isValid = true;
      else if (method === 'shadow_password' && credential === 'nero_shadow_secret_2026') isValid = true;
      else if (method === 'hardware_key' && (credential.includes('fido2') || credential === 'yubikey_tap_ok'))
        isValid = true;
      else if (method === 'mobile_otp' && credential && credential.length === 6) isValid = true;
      else if (credential === 'admin' || credential === 'admin123' || credential === 'demo' || credential === 'secret')
        isValid = true;

      return {
        authenticated: isValid,
        dms_state: isValid ? inMemoryNukeConfig.tier1b_personal_dms : null,
        time_remaining_seconds: isValid ? inMemoryNukeConfig.tier1b_personal_dms.heartbeat_interval_seconds : 0
      };
    },

    async resetPersonalDmsHeartbeat(passphrase) {
      const live = await request('/nuke/personal-dms/heartbeat', {
        method: 'POST',
        body: JSON.stringify({ passphrase })
      });
      if (live) return live;

      inMemoryNukeConfig.tier1b_personal_dms.last_heartbeat_at = new Date().toISOString();
      return {
        success: true,
        message: 'Personal DMS heartbeat re-confirmed. Timer reset.',
        last_heartbeat_at: inMemoryNukeConfig.tier1b_personal_dms.last_heartbeat_at
      };
    },

    // Tier 2: Network Owner Dead Man's Switch (Global Wipe)
    async setupOwnerDms(passphrase, heartbeatIntervalSeconds, webhookUrl) {
      const live = await request('/nuke/owner-dms/setup', {
        method: 'POST',
        body: JSON.stringify({
          passphrase,
          heartbeat_interval_seconds: heartbeatIntervalSeconds,
          webhook_url: webhookUrl
        })
      });
      if (live) return live;

      inMemoryNukeConfig.tier2_owner_dms = {
        armed: true,
        heartbeat_interval_seconds: Number(heartbeatIntervalSeconds),
        last_heartbeat_at: new Date().toISOString(),
        webhook_url: webhookUrl
      };
      return inMemoryNukeConfig.tier2_owner_dms;
    },

    async resetOwnerDmsHeartbeat(passphrase) {
      const live = await request('/nuke/owner-dms/heartbeat', {
        method: 'POST',
        body: JSON.stringify({ passphrase })
      });
      if (live) return live;

      inMemoryNukeConfig.tier2_owner_dms.last_heartbeat_at = new Date().toISOString();
      return {
        success: true,
        message: 'Network Owner DMS heartbeat confirmed. Global wipe timer reset.',
        last_heartbeat_at: inMemoryNukeConfig.tier2_owner_dms.last_heartbeat_at
      };
    },

    // Was '/nuke/owner-dms/trigger-wipe'; the route is '/nuke/owner-dms/trigger',
    // so this 404ed and the fixture below emptied some arrays and reported the wipe
    // done. The server now requires the phrase and the caller's own password: the
    // field sent here was named `passphrase` and the handler read neither.
    async triggerOwnerWipe({ confirmationPhrase, password }) {
      const live = await request('/nuke/owner-dms/trigger', {
        method: 'POST',
        body: JSON.stringify({
          confirmation_phrase: confirmationPhrase,
          password
        })
      });
      if (live) return live;

      inMemoryNodes = [];
      inMemoryUsers = [];
      inMemoryApps = [];
      inMemoryPeering = [];
      inMemoryRiskEvents = [];
      return {
        success: true,
        message: 'Cascading global wipe executed. Canary webhook alerted.'
      };
    },

    // Tier 3: Warrant Canary
    async getWarrantCanary() {
      const live = await request('/.well-known/canary.txt');
      if (typeof live === 'string') return live;
      return inMemoryNukeConfig.tier3_warrant_canary;
    }
  }
};

export default api;
