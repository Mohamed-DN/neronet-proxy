/*
 * The five kinds of device a person adds, and how to guess which one they are
 * holding. The guess only pre-selects a choice; the person can change it, and
 * nothing is sent anywhere because of it.
 */

export const PLATFORMS = ['ios', 'android', 'windows', 'macos', 'linux'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** A phone or tablet can scan a QR code shown on another screen; a computer's WireGuard app cannot. */
export function isMobilePlatform(platform: Platform): boolean {
  return platform === 'ios' || platform === 'android';
}

/**
 * Reads the browser's own description of itself. iPadOS 13 and later reports a
 * Mac, so a "Mac" with a touch screen is an iPad. Returns null when nothing
 * matches, and the page then asks instead of guessing.
 */
export function detectPlatform(
  userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent,
  touchPoints: number = typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints
): Platform | null {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'ios';
  if (/Android/i.test(userAgent)) return 'android';
  if (/Macintosh|Mac OS X/i.test(userAgent)) return touchPoints > 1 ? 'ios' : 'macos';
  if (/Windows/i.test(userAgent)) return 'windows';
  if (/Linux|X11|CrOS/i.test(userAgent)) return 'linux';
  return null;
}

/** Where the official WireGuard app for each platform is installed from. Official pages only. */
export const WIREGUARD_INSTALL: Record<Platform, string> = {
  ios: 'https://apps.apple.com/app/wireguard/id1441195209',
  android: 'https://play.google.com/store/apps/details?id=com.wireguard.android',
  windows: 'https://www.wireguard.com/install/',
  macos: 'https://apps.apple.com/app/wireguard/id1451685025',
  linux: 'https://www.wireguard.com/install/'
};

/**
 * Where the official AmneziaWG app for each platform comes from (ADR 0036). Official pages only:
 * the store listings and the project's own releases on GitHub.
 */
export const AMNEZIAWG_INSTALL: Record<Platform, string> = {
  ios: 'https://apps.apple.com/app/amneziawg/id6478942365',
  android: 'https://play.google.com/store/apps/details?id=org.amnezia.awg',
  windows: 'https://github.com/amnezia-vpn/amneziawg-windows-client/releases',
  macos: 'https://apps.apple.com/app/amneziawg/id6478942365',
  linux: 'https://github.com/amnezia-vpn/amneziawg-tools/releases'
};

/** The interface name used in the Linux commands: short, because Linux limits it to 15 characters. */
export const LINUX_INTERFACE = 'neronet';

/** Saves text as a file through the browser's download, without sending it anywhere. */
export function saveTextFile(text: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
