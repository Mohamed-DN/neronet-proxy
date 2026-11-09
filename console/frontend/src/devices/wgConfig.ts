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
  console_url: string;
}

export function buildProfileConfig(
  keys: { privateKey: string; presharedKey: string },
  device: ProfileDeviceResponse
): string {
  const lines = ['[Interface]', `PrivateKey = ${keys.privateKey}`, `Address = ${device.overlay_ipv4}/32`];
  if (device.dns.length > 0) lines.push(`DNS = ${device.dns.join(', ')}`);
  lines.push(
    '',
    '[Peer]',
    `PublicKey = ${device.gateway.public_key}`,
    `PresharedKey = ${keys.presharedKey}`,
    `Endpoint = ${device.gateway.endpoint}`,
    `AllowedIPs = ${device.allowed_ips.join(', ')}`,
    'PersistentKeepalive = 25'
  );
  return `${lines.join('\n')}\n`;
}

/** A file name from a device name: lowercase, [a-z0-9-], at most 32 characters, ".conf". */
export function configFileName(name: string): string {
  const stem = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  return `${stem || 'neronet'}.conf`;
}
