/**
 * The shapes the control plane returns, as far as the shell and pages read them.
 * Conforms to OpenAPI 3.1.0 specification in api/openapi.yaml (WP-403).
 */

export interface MeshNode {
  id: string;
  name?: string;
  hostname?: string;
  user_id?: string;
  role?: string;
  country_code?: string;
  overlay_ipv4?: string | null;
  is_quarantined?: boolean | number;
  is_healthy?: boolean | number;
  quarantine_reason?: string | null;
  /** null when the node has never been scored. */
  risk_score?: number | null;
  /** null when the node has never been heard from. */
  last_heartbeat?: string | null;
  compartment_id?: string | null;
  posture_status?: string | null;
  [key: string]: unknown;
}

export interface StatsOverview {
  active_nodes: number;
  total_nodes: number;
  quarantined_nodes: number;
  connected_users: number;
  /** null until two samples exist: a rate cannot be derived from one. */
  total_bandwidth_rx_mb_s: number | null;
  total_bandwidth_tx_mb_s: number | null;
  network_health_score: number | null;
  liveness_window_seconds: number;
  [key: string]: unknown;
}

export interface Features {
  cloud_pc: boolean;
  nuke?: boolean;
  onion?: boolean;
  deniability?: boolean;
  [key: string]: boolean | undefined;
}

export interface Compartment {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  subnet_cidr: string;
  is_hidden: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface AclRule {
  id: string;
  organization_id?: string;
  src_cidr: string;
  dst_cidr: string;
  proto: string;
  port: number;
  action: 'accept' | 'drop';
  description?: string;
}

export interface AuditEvent {
  sequence_num: number;
  event_type: string;
  actor_username?: string;
  actor_user_id?: string;
  target_id?: string;
  target_type?: string;
  message: string;
  ip_address?: string;
  created_at: string;
  chain_hash: string;
}

export interface RecoveryProof {
  id: string;
  proof_type: string;
  status: 'VERIFIED_PASS' | 'VERIFIED_FAIL' | 'RUNNING';
  verified_at: string;
  source_database: string;
  target_database: string;
  tables_verified: Record<string, number>;
  audit_chain_status: {
    verified: boolean;
    eventsChecked: number;
  };
  total_records_verified: number;
  execution_duration_ms: number;
  integrity_hash: string;
  created_by_user_id?: string;
  error_message?: string | null;
}

export interface HaLeaderStatus {
  instanceId: string;
  isLeader: boolean;
  leadershipAcquiredAt: string | null;
  lastHeartbeatAt: string | null;
}

export interface NukeStatus {
  armed: boolean;
  legalHold: boolean;
  pendingApprovals: Array<{
    id: string;
    proposed_by: string;
    created_at: string;
  }>;
}

export interface AuthSession {
  token: string;
  refreshToken?: string;
  accessTier: 'standard' | 'root';
  user: {
    id: string;
    username: string;
    role: string;
    organization_id?: string;
  };
}

export interface TimeseriesPoint {
  timestamp: string;
  time: string;
  rx: number;
  tx: number;
  rx_bytes?: number;
  tx_bytes?: number;
  active_nodes?: number;
  cpu_usage_pct?: number | null;
  memory_usage_mb?: number | null;
  health_score?: number | null;
  latency?: number | null;
}

export interface GeoMatrixEntry {
  country: string;
  code: string;
  nodes: number;
  live: number;
  relays: number;
  exits: number;
  avg_latency: number | null;
  status: 'Online' | 'Degraded' | 'Offline';
}
