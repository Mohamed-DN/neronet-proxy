import { describe, expect, it } from 'vitest';

import goldenAmnezia from './golden/amneziawg.conf?raw';
import goldenWireguard from './golden/wireguard.conf?raw';
import goldenWss from './golden/wireguard-wss.conf?raw';
import {
  amneziaConfigFileName,
  buildAmneziaConfig,
  buildProfileConfig,
  buildStrictNetworkConfig,
  configFileName,
  strictConfigFileName,
  wstunnelCommand,
  type AmneziaWgInfo,
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
  dns: ['100.100.100.100'],
  search_domain: 'acme.example.com',
  console_url: 'https://console.example.net/me',
  dns_name: 'work-phone.acme.example.com'
};

describe('buildProfileConfig', () => {
  it('builds the exact config', () => {
    const text = buildProfileConfig({ privateKey: 'PRIVKEY=', presharedKey: 'PSKKEY=' }, device);

    expect(text).toBe(
      [
        '# NeroNet-Profile: 1',
        '# NeroNet-Console: https://console.example.net',
        '# NeroNet-Device: dev-1',
        '# NeroNet-DNS-Name: work-phone.acme.example.com',
        '[Interface]',
        'PrivateKey = PRIVKEY=',
        'Address = 100.64.0.7/32',
        'DNS = 100.100.100.100, acme.example.com',
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

  it('writes the address only when the server names no search domain', () => {
    const text = buildProfileConfig({ privateKey: 'P=', presharedKey: 'S=' }, { ...device, search_domain: null });

    expect(text.split('\n')).toContain('DNS = 100.100.100.100');
  });

  it('writes no search domain without an address to go with it', () => {
    const text = buildProfileConfig({ privateKey: 'P=', presharedKey: 'S=' }, { ...device, dns: [], dns_name: null });

    expect(text).not.toContain('acme.example.com');
  });

  it('omits the DNS line when the list is empty', () => {
    const text = buildProfileConfig({ privateKey: 'P=', presharedKey: 'S=' }, { ...device, dns: [] });

    expect(text.split('\n').some((line) => line.startsWith('DNS ='))).toBe(false);
    expect(text.split('\n')).toEqual([
      '# NeroNet-Profile: 1',
      '# NeroNet-Console: https://console.example.net',
      '# NeroNet-Device: dev-1',
      '# NeroNet-DNS-Name: work-phone.acme.example.com',
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

describe('NeroNet metadata header', () => {
  const keys = { privateKey: 'P=', presharedKey: 'S=' };
  const head = (text: string) => text.split('\n').slice(0, text.split('\n').indexOf('[Interface]'));

  it('omits the DNS name line when the server sent none', () => {
    const base = ['# NeroNet-Profile: 1', '# NeroNet-Console: https://console.example.net', '# NeroNet-Device: dev-1'];
    expect(head(buildProfileConfig(keys, { ...device, dns_name: null }))).toEqual(base);
    expect(head(buildProfileConfig(keys, { ...device, dns_name: undefined }))).toEqual(base);
  });

  it('omits the console line unless the address is https', () => {
    for (const url of ['http://console.example.net/me', 'not a url', '']) {
      expect(buildProfileConfig(keys, { ...device, console_url: url })).not.toContain('NeroNet-Console');
    }
  });

  it('writes only the origin of the console address', () => {
    const text = buildProfileConfig(keys, { ...device, console_url: 'https://console.example.net:8443/me?x=1' });
    expect(text).toContain('# NeroNet-Console: https://console.example.net:8443\n');
  });

  it('is on the strict-network profile too, before the Interface section', () => {
    const text = buildStrictNetworkConfig(keys, device, strict);
    expect(text.startsWith('# NeroNet-Profile: 1\n')).toBe(true);
    expect(text).toContain('# NeroNet-Device: dev-1');
  });
});

describe('QR code with the metadata header', () => {
  it('still fits in one QR code at medium error correction, also with the longest header', async () => {
    const QRCode = (await import('qrcode')).default;
    const keys = { privateKey: 'P'.repeat(44), presharedKey: 'S'.repeat(44) };
    const longest: ProfileDeviceResponse = {
      ...device,
      device_id: 'node-0123456789abcdef0123456789abcdef',
      console_url: `https://${'c'.repeat(63)}.${'d'.repeat(63)}.example.com:8443/me`,
      dns_name: `${'x'.repeat(63)}.${'y'.repeat(63)}.example.com`
    };
    for (const text of [
      buildProfileConfig(keys, longest),
      buildStrictNetworkConfig(keys, longest, strict),
      buildAmneziaConfig(keys, longest, awg)
    ]) {
      expect(new TextEncoder().encode(text).length).toBeLessThan(2000);
      await expect(QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 2, width: 256 })).resolves.toMatch(
        /^data:image\/png/
      );
    }
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

    expect(text.split('\n')).toEqual([
      '# NeroNet-Profile: 1',
      '# NeroNet-Console: https://console.example.net',
      '# NeroNet-Device: dev-1',
      '# NeroNet-DNS-Name: work-phone.acme.example.com',
      '[Interface]',
      'PrivateKey = PRIVKEY=',
      'Address = 100.64.0.7/32',
      'DNS = 100.100.100.100, acme.example.com',
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

// ADR 0036: one golden file per access method. The values are obviously made up; what is
// pinned is which lines a method writes, in which order, under which names.
const awg: AmneziaWgInfo = {
  endpoint: 'gw.example.net:51821',
  params: {
    jc: 7,
    jmin: 40,
    jmax: 90,
    s1: 21,
    s2: 22,
    s3: 23,
    s4: 24,
    h1: '100000-100999',
    h2: '200000-200999',
    h3: '300000-300999',
    h4: '400000-400999'
  }
};
const goldenDevice: ProfileDeviceResponse = { ...device, allowed_ips: ['100.64.0.0/10'] };
const goldenKeys = { privateKey: 'PRIVKEY=', presharedKey: 'PSKKEY=' };

describe('golden profiles per access method', () => {
  it('wireguard', () => {
    expect(buildProfileConfig(goldenKeys, goldenDevice)).toBe(goldenWireguard);
  });

  it('wireguard-wss', () => {
    expect(buildStrictNetworkConfig(goldenKeys, goldenDevice, strict)).toBe(goldenWss);
  });

  it('amneziawg', () => {
    expect(buildAmneziaConfig(goldenKeys, goldenDevice, awg)).toBe(goldenAmnezia);
  });

  it('amneziawg writes every key the official apps read, under their names, in [Interface] only', () => {
    // Parameters made at test time, as the console makes them: nothing here is a stored value.
    const rnd = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));
    const info: AmneziaWgInfo = {
      endpoint: 'gw.example.net:51821',
      params: {
        jc: rnd(4, 12),
        jmin: rnd(8, 60),
        jmax: rnd(100, 400),
        s1: rnd(15, 150),
        s2: rnd(15, 150),
        s3: rnd(8, 64),
        s4: rnd(4, 32),
        h1: '1000-1999',
        h2: '3000-3999',
        h3: '5000-5999',
        h4: '7000-7999'
      }
    };
    const text = buildAmneziaConfig(goldenKeys, goldenDevice, info);
    const [iface, peer] = text.split('\n[Peer]\n');
    for (const name of ['Jc', 'Jmin', 'Jmax', 'S1', 'S2', 'S3', 'S4', 'H1', 'H2', 'H3', 'H4']) {
      expect(iface).toMatch(new RegExp(`^${name} = [0-9]+(-[0-9]+)?$`, 'm'));
      expect(peer).not.toContain(`${name} =`);
    }
    expect(peer).toContain('Endpoint = gw.example.net:51821');
  });

  it('keeps the NeroNet header lines in all three', () => {
    for (const text of [goldenWireguard, goldenWss, goldenAmnezia]) {
      expect(text.split('\n').slice(0, 4)).toEqual([
        '# NeroNet-Profile: 1',
        '# NeroNet-Console: https://console.example.net',
        '# NeroNet-Device: dev-1',
        '# NeroNet-DNS-Name: work-phone.acme.example.com'
      ]);
    }
  });
});

describe('amneziaConfigFileName', () => {
  it('adds -awg and stays within 32 characters', () => {
    expect(amneziaConfigFileName('Work laptop')).toBe('work-laptop-awg.conf');
    expect(amneziaConfigFileName('a'.repeat(50)).replace(/\.conf$/, '')).toHaveLength(32);
  });
});
