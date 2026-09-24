import http from 'k6/http';
import { check } from 'k6';

export const options = {
  scenarios: {
    heartbeat_100k_fleet: {
      executor: 'ramping-arrival-rate',
      startRate: 500,
      timeUnit: '1s',
      preAllocatedVUs: 200,
      maxVUs: 1000,
      stages: [
        { target: 2000, duration: '10s' },
        { target: 5000, duration: '20s' },
        { target: 7000, duration: '20s' }, // ~100k nodes beating every 15s = ~6,667 RPS
        { target: 1000, duration: '10s' }
      ]
    }
  },
  thresholds: {
    http_req_failed: ['rate<0.0001'],
    http_req_duration: ['p(95)<50', 'p(99)<150']
  }
};

const BASE_URL = __ENV.BACKEND_URL || 'http://127.0.0.1:8081';
const HEADERS = {
  'Content-Type': 'application/json',
  'X-Sovereign-Node-Auth': 'dev-token'
};

export default function () {
  const nodeId = 'node-' + (__VU % 1000) + '-' + (__ITER % 100);
  const payload = JSON.stringify({
    node_id: nodeId,
    cpu_usage_pct: 12.5,
    memory_usage_mb: 256,
    battery_level_pct: 98,
    tx_bytes_sec: 1048576,
    rx_bytes_sec: 2097152,
    rtt_ms: 15,
    posture: {
      integrity: 'verified',
      tpm_present: true,
      secure_boot: true
    }
  });

  const res = http.post(BASE_URL + '/v4/control/heartbeat', payload, { headers: HEADERS });
  check(res, {
    'status is 200': (r) => r.status === 200,
    'status ok in body': (r) => r.body && r.body.includes('"status":"ok"')
  });
}
