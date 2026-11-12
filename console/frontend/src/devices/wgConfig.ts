/**
 * The WireGuard configuration text for a profile device, and its file name.
 *
 * Pure: the caller supplies the keys and the server's answer, and gets back
 * the text. The private key is written only into this string, which the
 * caller hands to a download or a QR code and does not store.
 */

export interface ProfileDeviceResponse {
  device_id: string;
  name: string;
  overlay_ipv4: string;
  overlay_ipv6?: string | null;
  gateway: { public_key: string; endpoint: string };
  allowed_ips: string[];
  dns: string[];
  /** ADR 0032: present when every packet leaves through this exit (AllowedIPs 0.0.0.0/0, ::/0). */
  exit?: { node_id: string; name: string; kind: 'gateway' | 'node' };
  console_url: string;
  /**
   * The strict-network tunnel (WireGuard inside a WebSocket on port 443), when the
   * installation runs it. path_prefix is a per-installation secret, given only to a
   * signed-in user with the profile they just made. Absent or null: not offered.
   */
  strict_network?: StrictNetwork | null;
}

export interface StrictNetwork {
  /** wss:// address the client dials, for example wss://vpn.example.org */
  url: string;
  path_prefix: string;
  /** The gateway's WireGuard port as the tunnel server names it, for example gateway:51820 */
  remote: string;
  /** Where the client listens on the computer; the alternative profile points here. */
  local_endpoint: string;
  mtu: number;
  persistent_keepalive: number;
}

/** The upstream wstunnel release the command and the handbook were tested with. */
export const WSTUNNEL_VERSION = '11.1.0';
export const WSTUNNEL_RELEASE_URL = `https://github.com/erebe/wstunnel/releases/tag/v${WSTUNNEL_VERSION}`;

export type DesktopShell = 'unix' | 'windows';

export function buildProfileConfig(
  keys: { privateKey: string; presharedKey: string },
  device: ProfileDeviceResponse
): string {
  return configText(keys, device, { endpoint: device.gateway.endpoint, keepalive: 25 });
}

/**
 * The same device's profile for a network that blocks VPNs: the same keys and address,
 * but WireGuard talks to the wstunnel client on this computer instead of the gateway,
 * with a smaller MTU for the WebSocket and TLS overhead.
 */
export function buildStrictNetworkConfig(
  keys: { privateKey: string; presharedKey: string },
  device: ProfileDeviceResponse,
  strict: StrictNetwork
): string {
  return configText(keys, device, {
    endpoint: strict.local_endpoint,
    keepalive: strict.persistent_keepalive,
    mtu: strict.mtu
  });
}

function configText(
  keys: { privateKey: string; presharedKey: string },
  device: ProfileDeviceResponse,
  peer: { endpoint: string; keepalive: number; mtu?: number }
): string {
  const lines = ['[Interface]', `PrivateKey = ${keys.privateKey}`, `Address = ${device.overlay_ipv4}/32`];
  if (device.dns.length > 0) lines.push(`DNS = ${device.dns.join(', ')}`);
  if (peer.mtu) lines.push(`MTU = ${peer.mtu}`);
  lines.push(
    '',
    '[Peer]',
    `PublicKey = ${device.gateway.public_key}`,
    `PresharedKey = ${keys.presharedKey}`,
    `Endpoint = ${peer.endpoint}`,
    `AllowedIPs = ${device.allowed_ips.join(', ')}`,
    `PersistentKeepalive = ${peer.keepalive}`
  );
  return `${lines.join('\n')}\n`;
}

/**
 * The wstunnel client command that carries the alternative profile's packets over
 * port 443. The certificate is checked (wstunnel does not by default), and the UDP
 * listener never times out, so a quiet tunnel is not closed under WireGuard.
 */
export function wstunnelCommand(strict: StrictNetwork, shell: DesktopShell): string {
  const binary = shell === 'windows' ? '.\\wstunnel.exe' : 'wstunnel';
  return [
    binary,
    'client',
    '--tls-verify-certificate',
    '-P',
    strict.path_prefix,
    '-L',
    `'udp://${strict.local_endpoint}:${strict.remote}?timeout_sec=0'`,
    strict.url
  ].join(' ');
}

/** A file name from a device name: lowercase, [a-z0-9-], at most 32 characters, ".conf". */
export function configFileName(name: string): string {
  return `${fileStem(name, 32)}.conf`;
}

/**
 * The alternative profile's file name: the same stem plus "-443", still at most 32
 * characters, the longest tunnel name the WireGuard app for Windows accepts.
 */
export function strictConfigFileName(name: string): string {
  return `${fileStem(name, 28)}-443.conf`;
}

function fileStem(name: string, max: number): string {
  const stem = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return stem || 'neronet';
}
