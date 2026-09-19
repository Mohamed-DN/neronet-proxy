const jwt = require('jsonwebtoken');

const API_URL = 'http://127.0.0.1:8081/api';
const config = require('./config/env');

// Sign with the same secret the API verifies with. A second copy of the literal here
// is how the two drift apart, and how a published default outlives the config that
// was meant to replace it.
const SECRET = config.JWT_SECRET;

const adminToken = jwt.sign({ id: 'usr-admin-seed', username: 'admin', role: 'super-admin' }, SECRET, {
  expiresIn: '1d'
});

const nodes = [
  { id: 'node-sim-us', name: 'US-East-Bridge', role: 'EXIT_BRIDGE', country_code: 'US', lat: 37.77, lng: -122.41 },
  { id: 'node-sim-de', name: 'Frankfurt-Relay', role: 'RELAY', country_code: 'DE', lat: 50.11, lng: 8.68 },
  { id: 'node-sim-jp', name: 'Tokyo-Client', role: 'EDGE_CLIENT', country_code: 'JP', lat: 35.67, lng: 139.65 }
];

async function registerNode(node) {
  try {
    const res = await fetch(`${API_URL}/nodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        name: node.name,
        role: node.role,
        country_code: node.country_code,
        latitude: node.lat,
        longitude: node.lng,
        ip_class: 'residential',
        metadata: { simulator: true }
      })
    });
    const data = await res.json();
    console.log(`[SIMULATOR] Register ${node.name}:`, data);
    if (data.node) node.dbId = data.node.id;
  } catch (err) {
    console.error(`[SIMULATOR] Failed to register ${node.name}:`, err.message);
  }
}

async function sendHeartbeat(node) {
  if (!node.dbId) return;
  try {
    const res = await fetch(`${API_URL}/nodes/${node.dbId}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        latency_ms: Math.floor(Math.random() * 50) + 10,
        rx_bytes: Math.floor(Math.random() * 1000000),
        tx_bytes: Math.floor(Math.random() * 500000),
        cpu_usage_pct: Math.floor(Math.random() * 40) + 10,
        memory_usage_pct: Math.floor(Math.random() * 60) + 20
      })
    });
    console.log(`[SIMULATOR] Heartbeat sent for ${node.name} [${res.status}]`);
  } catch (err) {
    console.error(`[SIMULATOR] Heartbeat failed for ${node.name}:`, err.message);
  }
}

async function start() {
  console.log('[SIMULATOR] Booting Mesh Simulator...');
  for (const n of nodes) {
    await registerNode(n);
  }

  setInterval(() => {
    for (const n of nodes) {
      sendHeartbeat(n);
    }
  }, 3000);
}

start();
