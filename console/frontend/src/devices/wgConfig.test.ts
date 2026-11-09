import { describe, expect, it } from 'vitest';

import { buildProfileConfig, configFileName, type ProfileDeviceResponse } from './wgConfig';

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
