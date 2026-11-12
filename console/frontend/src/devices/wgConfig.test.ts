import { describe, expect, it } from 'vitest';

import {
  buildProfileConfig,
  buildStrictNetworkConfig,
  configFileName,
  strictConfigFileName,
  wstunnelCommand,
  type ProfileDeviceResponse,
  type StrictNetwork
} from './wgConfig';

const device: ProfileDeviceResponse = {
  device_id: 'dev-1',
  name: 'Work phone',
  overlay_ipv4: '100.64.0.7',
  overlay_ipv6: null,
  gateway: { public_key: 'GATEWAYPUB=', endpoint: 'gw.example.net:51820' },
  allowed_ips: ['100.64.0.0/10', 'fd7a:115c:a1e0::/48'],
  dns: ['100.64.0.1', '1.1.1.1'],
  console_url: 'https://console.example.net'
};

describe('buildProfileConfig', () => {
  it('builds the exact config', () => {
    const text = buildProfileConfig({ privateKey: 'PRIVKEY=', presharedKey: 'PSKKEY=' }, device);

    expect(text).toBe(
      [
        '[Interface]',
        'PrivateKey = PRIVKEY=',
        'Address = 100.64.0.7/32',
        'DNS = 100.64.0.1, 1.1.1.1',
        '',
        '[Peer]',
        'PublicKey = GATEWAYPUB=',
        'PresharedKey = PSKKEY=',
        'Endpoint = gw.example.net:51820',
        'AllowedIPs = 100.64.0.0/10, fd7a:115c:a1e0::/48',
        'PersistentKeepalive = 25',
        ''
      ].join('\n')
    );
  });

  it('omits the DNS line when the list is empty', () => {
    const text = buildProfileConfig({ privateKey: 'P=', presharedKey: 'S=' }, { ...device, dns: [] });

    expect(text).not.toContain('DNS');
    expect(text.split('\n')).toEqual([
      '[Interface]',
      'PrivateKey = P=',
      'Address = 100.64.0.7/32',
      '',
      '[Peer]',
      'PublicKey = GATEWAYPUB=',
      'PresharedKey = S=',
      'Endpoint = gw.example.net:51820',
      'AllowedIPs = 100.64.0.0/10, fd7a:115c:a1e0::/48',
      'PersistentKeepalive = 25',
      ''
    ]);
  });
});

describe('configFileName', () => {
  it('lowercases the name and keeps only letters, digits and dashes', () => {
    expect(configFileName('Work phone!')).toBe('work-phone.conf');
  });

  it('falls back to neronet.conf for an empty name', () => {
    expect(configFileName('   ')).toBe('neronet.conf');
  });

  it('caps the stem at 32 characters', () => {
    expect(configFileName('a'.repeat(50))).toBe(`${'a'.repeat(32)}.conf`);
  });
});

const strict: StrictNetwork = {
  url: 'wss://vpn.example.net',
  path_prefix: '0123456789abcdef0123456789abcdef',
  remote: 'gateway:51820',
  local_endpoint: '127.0.0.1:51820',
  mtu: 1380,
  persistent_keepalive: 20
};

describe('buildStrictNetworkConfig', () => {
  it('keeps the keys and the address and points WireGuard at the local wstunnel client', () => {
    const text = buildStrictNetworkConfig({ privateKey: 'PRIVKEY=', presharedKey: 'PSKKEY=' }, device, strict);

    expect(text.split('
')).toEqual([
      '[Interface]',
      'PrivateKey = PRIVKEY=',
      'Address = 100.64.0.7/32',
      'DNS = 100.64.0.1, 1.1.1.1',
      'MTU = 1380',
      '',
      '[Peer]',
      'PublicKey = GATEWAYPUB=',
      'PresharedKey = PSKKEY=',
      'Endpoint = 127.0.0.1:51820',
      'AllowedIPs = 100.64.0.0/10, fd7a:115c:a1e0::/48',
      'PersistentKeepalive = 20',
      ''
    ]);
  });
});

describe('wstunnelCommand', () => {
  it('checks the certificate and forwards only the local UDP port to the gateway', () => {
    expect(wstunnelCommand(strict, 'unix')).toBe(
      "wstunnel client --tls-verify-certificate -P 0123456789abcdef0123456789abcdef -L 'udp://127.0.0.1:51820:gateway:51820?timeout_sec=0' wss://vpn.example.net"
    );
  });

  it('runs the binary from the current folder in PowerShell', () => {
    expect(wstunnelCommand(strict, 'windows')).toMatch(/^\.\\wstunnel\.exe client --tls-verify-certificate /);
  });
});

describe('strictConfigFileName', () => {
  it('adds -443 and stays within the 32 characters the WireGuard app for Windows accepts', () => {
    expect(strictConfigFileName('Work laptop')).toBe('work-laptop-443.conf');
    expect(strictConfigFileName('a'.repeat(50)).replace(/\.conf$/, '')).toHaveLength(32);
  });
});
