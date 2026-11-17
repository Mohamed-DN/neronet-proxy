import { describe, expect, it } from 'vitest';

import en from '../i18n/locales/en/portal.json';
import it_ from '../i18n/locales/it/portal.json';

/**
 * A member is not an administrator. These words describe how the network works
 * and mean nothing to someone adding a phone, so they stay out of every string a
 * member reads. The advanced keys are for the few people who need them (a
 * network that blocks VPNs) and sit behind a closed section.
 */
const FORBIDDEN =
  /\b(keys?|chiav[ei]|cidr|endpoint|handshake|gateway|wstunnel|powershell|port|porta|exit|uscit[ae]|nodo|nodi|nodes?|tunnels?|vpns?|access codes?|codice di accesso|codici di accesso)\b/i;

/** In English the real setting is called "Exclude private IPs" and the person has to find it by that name. */
const RAW_SETTING = /exclude private ips/i;

/** Sections behind "Hai problemi a collegarti?": the blocked-network help. */
const ADVANCED = ['add.strict.'];

/**
 * Names of the WireGuard app's own buttons, quoted as the app shows them. A person has to find
 * them by that name, so they are not jargon of ours.
 */
const APP_LABELS = ['add.how.'];

function strings(node: unknown, path = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[path, node]];
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([key, child]) => strings(child, path ? path + '.' + key : key));
  }
  return [];
}

describe('portal copy for members', () => {
  for (const [lang, doc] of [
    ['it', it_],
    ['en', en]
  ] as const) {
    it(lang + ': no technical term outside the advanced keys', () => {
      const found = strings(doc)
        .filter(([path]) => !ADVANCED.some((prefix) => path.startsWith(prefix)))
        // The app's own menu names are quoted: strip the quotes' content before looking for our own words.
        .map(([path, value]): [string, string] => [
          path,
          APP_LABELS.some((prefix) => path.startsWith(prefix)) ? value.replace(/"[^"]*"/g, '') : value
        ])
        .filter(([, value]) => FORBIDDEN.test(value))
        .map(([path, value]) => path + ': ' + value);
      expect(found.join('\n')).toBe('');
    });
  }

  it('it: no raw English setting name in Italian', () => {
    const found = strings(it_)
      .filter(([, value]) => RAW_SETTING.test(value))
      .map(([path]) => path);
    expect(found).toEqual([]);
  });

  it('the advanced keys that remain are the ones the blocked-network section reads', () => {
    for (const doc of [it_, en]) {
      const advanced = strings(doc).filter(([path]) => ADVANCED.some((prefix) => path.startsWith(prefix)));
      expect(advanced.length).toBeGreaterThan(5);
    }
  });

  it('en and it have the same keys', () => {
    expect(
      strings(en)
        .map(([path]) => path)
        .sort()
    ).toEqual(
      strings(it_)
        .map(([path]) => path)
        .sort()
    );
  });
});
