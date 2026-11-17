import { describe, expect, it } from 'vitest';

import { detectPlatform, isMobilePlatform } from './platform';

describe('detectPlatform', () => {
  it.each([
    ['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15', 5, 'ios'],
    ['iPad', 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15', 5, 'ios'],
    ['iPadOS posing as a Mac', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 5, 'ios'],
    ['Android', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile', 5, 'android'],
    ['Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0', 0, 'windows'],
    ['Mac', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', 0, 'macos'],
    ['Linux', 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0', 0, 'linux']
  ])('%s', (_name, userAgent, touchPoints, expected) => {
    expect(detectPlatform(userAgent, touchPoints)).toBe(expected);
  });

  it('says nothing when it cannot tell', () => {
    expect(detectPlatform('SomethingElse/1.0', 0)).toBeNull();
  });

  it('knows which platforms can scan a QR code shown on another screen', () => {
    expect(isMobilePlatform('ios')).toBe(true);
    expect(isMobilePlatform('android')).toBe(true);
    expect(isMobilePlatform('windows')).toBe(false);
    expect(isMobilePlatform('macos')).toBe(false);
    expect(isMobilePlatform('linux')).toBe(false);
  });
});
