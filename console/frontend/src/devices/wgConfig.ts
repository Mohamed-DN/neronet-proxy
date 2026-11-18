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
  /** ADR 0034: written after the addresses in the DNS line so the app searches it. */
  search_domain?: string | null;
  /** ADR 0032: present when every packet leaves through this exit (AllowedIPs 0.0.0.0/0, ::/0). */
  exit?: { node_id: string; name: string; kind: 'gateway' | 'node' };
  console_url: string;
  /** ADR 0034: the stored mesh name, unique in the organisation; null or absent when the device has none. */
  dns_name?: string | null;
  /**
   * The strict-network tunnel (WireGuard inside a WebSocket on port 443), when the
   * installation runs it. path_prefix is a per-installation secret, given only to a
   * signed-in user with the profile they just made. Absent or null: not offered.
   */
  strict_network?: StrictNetwork | null;
  /** ADR 0036: the way this device connects. Absent on an older server: plain WireGuard. */
  access_method?: AccessMethod;
  /** Present for an AmneziaWG device: the listener's address and the organisation's obfuscation parameters. */
  amneziawg?: AmneziaWgInfo | null;
}

export type AccessMethod = 'wireguard' | 'wireguard-wss' | 'amneziawg';

/**
 * The organisation's AmneziaWG obfuscation parameters, as the console generated them. They
 * are a secret of the same kind as a key: they are written into the profile and nowhere else.
 * H1 to H4 are ranges ("low-high"), as AmneziaWG 2.0 reads them.
 */
export interface AwgParams {
  jc: number;
  jmin: number;
  jmax: number;
  s1: number;
  s2: number;
  s3: number;
  s4: number;
  h1: string;
  h2: string;
  h3: string;
  h4: string;
}

export interface AmneziaWgInfo {
  /** host:port of the gateway's AmneziaWG listener. */
  endpoint: string;
  params: AwgParams;
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

/**
 * The profile for a network that recognises VPNs: AmneziaWG. Same keys and address as the
 * plain profile; the [Interface] section also carries the obfuscation parameters, under the
 * names the official AmneziaWG apps read (Jc, Jmin, Jmax, S1 to S4, H1 to H4), and the
 * Endpoint is the gateway's AmneziaWG listener. Import it into the AmneziaWG app, not the
 * WireGuard one: a stock WireGuard app does not know these keys.
 */
export function buildAmneziaConfig(
  keys: { privateKey: string; presharedKey: string },
  device: ProfileDeviceResponse,
  awg: AmneziaWgInfo
): string {
  const p = awg.params;
  return configText(keys, device, { endpoint: awg.endpoint, keepalive: 25 }, [
    `Jc = ${p.jc}`,
    `Jmin = ${p.jmin}`,
    `Jmax = ${p.jmax}`,
    `S1 = ${p.s1}`,
    `S2 = ${p.s2}`,
    `S3 = ${p.s3}`,
    `S4 = ${p.s4}`,
    `H1 = ${p.h1}`,
    `H2 = ${p.h2}`,
    `H3 = ${p.h3}`,
    `H4 = ${p.h4}`
  ]);
}

/**
 * ADR 0029: NeroNet metadata as comment lines before [Interface]. Stock WireGuard apps
 * ignore them; the NeroNet apps read the device name, the console and the NeroDrop button
 * from them. The console is written as its origin and only when it is https.
 */
function metadataLines(device: ProfileDeviceResponse): string[] {
  const lines = ['# NeroNet-Profile: 1'];
  try {
    const url = new URL(device.console_url);
    if (url.protocol === 'https:') lines.push(`# NeroNet-Console: ${url.origin}`);
  } catch {
    // Not an address: leave the line out rather than write a value the apps would refuse.
  }
  lines.push(`# NeroNet-Device: ${device.device_id}`);
  if (device.dns_name) lines.push(`# NeroNet-DNS-Name: ${device.dns_name}`);
  return lines;
}

function configText(
  keys: { privateKey: string; presharedKey: string },
  device: ProfileDeviceResponse,
  peer: { endpoint: string; keepalive: number; mtu?: number },
  interfaceExtras: string[] = []
): string {
  const lines = [
    ...metadataLines(device),
    '[Interface]',
    `PrivateKey = ${keys.privateKey}`,
    `Address = ${device.overlay_ipv4}/32`
  ];
  if (device.dns.length > 0) {
    // wg-quick and the stock apps read names after the addresses as search domains.
    const entries = device.search_domain ? [...device.dns, device.search_domain] : device.dns;
    lines.push(`DNS = ${entries.join(', ')}`);
  }
  if (peer.mtu) lines.push(`MTU = ${peer.mtu}`);
  lines.push(...interfaceExtras);
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

/** The AmneziaWG profile's file name: the same stem plus "-awg", at most 32 characters. */
export function amneziaConfigFileName(name: string): string {
  return `${fileStem(name, 28)}-awg.conf`;
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
