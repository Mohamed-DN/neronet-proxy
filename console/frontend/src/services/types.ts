/**
 * The shapes the control plane returns, as far as the shell and pages read them.
 * Conforms to OpenAPI 3.1.0 specification in api/openapi.yaml (WP-403).
 */

export interface PostureChecks {
  os_name?: string | null;
  os_version?: string | null;
  client_version?: string | null;
  disk_encrypted?: boolean | null;
  firewall_active?: boolean | null;
  is_rootless?: boolean | null;
  measured_at?: string | null;
}

export interface MeshNode {
  id: string;
  name?: string;
  hostname?: string;
  user_id?: string;
  role?: string;
  country_code?: string;
  city?: string;
  overlay_ipv4?: string | null;
  overlay_ipv6?: string | null;
  public_key?: string;
  is_quarantined?: boolean | number;
  is_healthy?: boolean | number;
  quarantine_reason?: string | null;
  /** null when the node has never been scored. */
  risk_score?: number | null;
  /** null when the node has never been heard from. */
  last_heartbeat?: string | null;
  last_seen?: string | null;
  compartment_id?: string | null;
  posture_status?: 'verified_compliant' | 'unverified' | 'non_compliant' | string | null;
  posture_checks?: PostureChecks | null;
  latency_ms?: number | null;
  jitter_ms?: number | null;
  tx_bytes?: number;
  rx_bytes?: number;
  cpu_usage_pct?: number | null;
  endpoints?: string[];
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
  priority?: number;
  source_cidr?: string;
  destination_cidr?: string;
  src_cidr?: string;
  dst_cidr?: string;
  protocol?: 'ALL' | 'TCP' | 'UDP' | 'ICMP' | string;
  proto?: string;
  port_start?: number;
  port_end?: number;
  port?: number;
  action: 'ACCEPT' | 'DROP' | 'accept' | 'drop';
  description?: string;
  enabled?: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface AclRulesResponse {
  rules: AclRule[];
  epoch: number;
  policy_is_open: boolean;
  count: number;
}

export interface CompiledPolicyRule {
  allowed_peer_vip: string;
  protocol: string;
  port_ranges: Array<{ start: number; end: number }>;
  action: string;
  is_directional: boolean;
  rule_id?: string;
}

export interface CompiledPolicy {
  node_id: string;
  overlay_ipv4: string;
  inbound_rules: CompiledPolicyRule[];
  outbound_rules: CompiledPolicyRule[];
  epoch: number;
  is_preview?: boolean;
}

export interface AclSimulationResult {
  verdict: 'ACCEPT' | 'DROP';
  matched_rule: AclRule | null;
  reason: string;
  packet: {
    source_ip: string;
    destination_ip: string;
    protocol: string;
    port: number;
  };
}

export interface AclDefaultPolicyResponse {
  organization_id: string;
  organization_name: string;
  default_policy: 'open' | 'deny';
  epoch?: number;
}

export interface AuditEvent {
  id?: string | number;
  sequence_num: number;
  prev_hash?: string;
  entry_hash?: string;
  chain_hash?: string;
  event_type: string;
  severity?: 'info' | 'warn' | 'critical' | 'error' | string;
  actor_username?: string;
  actor_user_id?: string;
  target_id?: string;
  target_type?: string;
  message: string;
  ip_address?: string;
  user_agent?: string;
  metadata_json?: Record<string, unknown> | null;
  created_at: string;
}

export interface AuditVerificationResult {
  valid: boolean;
  events_count?: number;
  first_sequence?: number;
  last_sequence?: number;
  broken_at_sequence?: number | null;
  reason?: string | null;
  timestamp?: string;
}

export interface AuditCheckpoint {
  id: string;
  sequence_num: number;
  event_hash: string;
  signature: string;
  public_key?: string;
  created_at: string;
}

export interface SiemDestination {
  id: string;
  name: string;
  protocol: 'udp' | 'tcp' | 'tls' | string;
  endpoint: string;
  format: 'rfc5424' | 'cef' | 'leef' | 'json' | string;
  enabled: boolean;
  created_at?: string;
}

export interface AuditLogsResponse {
  audit_logs: AuditEvent[];
  total: number;
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

export interface TopologyNode {
  id: string;
  name: string;
  role: string;
  country: string;
  overlay_ipv4: string | null;
  is_healthy: boolean;
  is_quarantined: boolean;
  latency_ms: number | null;
  compartment_id: string | null;
  compartment_name: string;
  is_ghost_vault: boolean;
  [key: string]: unknown;
}

export interface TopologyLink {
  source: string;
  target: string;
  protocol?: string;
  mode?: 'direct' | 'derp' | 'openvpn' | 'onion';
  relay_id?: string | null;
  is_visible?: boolean;
  [key: string]: unknown;
}

export interface TopologyData {
  nodes: TopologyNode[];
  links: TopologyLink[];
  total_nodes: number;
  policy_is_open: boolean;
  mesh_scope: string;
}

export interface LegalHold {
  id: string;
  organization_id: string;
  reason: string;
  imposed_by_user_id: string;
  active: boolean;
  created_at: string;
  released_at?: string | null;
}

export interface DualAuthRequest {
  id: string;
  target_type: 'organization' | 'global';
  target_id: string;
  initiator_user_id: string;
  initiator_comment?: string | null;
  approver_user_id?: string | null;
  approver_comment?: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'executed' | 'cancelled' | 'expired';
  expires_at: string;
  created_at: string;
  executed_at?: string | null;
}

export interface NukeGovernanceOverview {
  armed: boolean;
  legal_hold_active: boolean;
  active_legal_holds: number;
  pending_authorizations: number;
  keys_status: 'active' | 'destroyed' | 'frozen';
  owner_dms_armed?: boolean;
}

export interface UserAccount {
  id: string;
  username: string;
  email: string;
  role: 'super-admin' | 'admin' | 'operator' | 'auditor' | 'user';
  status: 'active' | 'suspended' | 'pending';
  bypass_apps: string[];
  organization_id?: string;
  created_at: string;
  updated_at?: string;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  default_policy?: 'open' | 'deny';
  max_netmap_staleness_seconds?: number;
  created_at?: string;
  updated_at?: string;
}

export interface QrOnboardingData {
  config_text: string;
  qr_code_svg?: string;
  qr_code_data_url?: string;
  endpoint?: string;
  expires_at?: string;
}

export interface CreateUserPayload {
  username: string;
  password?: string;
  email?: string;
  role: 'super-admin' | 'admin' | 'operator' | 'auditor' | 'user';
  organization_id?: string;
  bypass_apps?: string[];
}

export interface CreateOrgPayload {
  name: string;
  slug?: string;
  default_policy?: 'open' | 'deny';
  max_netmap_staleness_seconds?: number;
}
