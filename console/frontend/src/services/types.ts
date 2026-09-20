/**
 * The shapes the control plane returns, as far as the shell reads them.
 *
 * Only the fields the app shell and its query hooks use are declared. The pages
 * under src/components still read these objects as plain JavaScript; each page's
 * own work package types what it needs. An index signature keeps that legal
 * without pretending this file is the schema.
 *
 * Every field that the control plane can leave unmeasured is nullable here. A
 * `number` that is really `number | null` is how a console ends up drawing a
 * zero where nothing was ever measured.
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
}
