import { describe, expect, it } from 'vitest';

import chromeEn from './locales/en/chrome.json';
import portalEn from './locales/en/portal.json';
import portalIt from './locales/it/portal.json';
import { lazyLocaleBackend } from './backend';
import { EAGER_NAMESPACES } from './index';

describe('lazy locale loading', () => {
  it('keeps only the shell and ui namespaces in the entry, and the sign-in strings live in chrome', () => {
    expect([...EAGER_NAMESPACES].sort()).toEqual(['chrome', 'ui']);
    expect(chromeEn).toHaveProperty('login');
  });

  it('the production backend read() loads a namespace file and calls back with its JSON', async () => {
    const readNamespace = (lng: string, ns: string) =>
      new Promise<unknown>((resolve, reject) => {
        lazyLocaleBackend.read(lng, ns, (error: unknown, data: unknown) => {
          if (error) reject(error);
          else resolve(data);
        });
      });

    await expect(readNamespace('en', 'portal')).resolves.toEqual(portalEn);
    await expect(readNamespace('it', 'portal')).resolves.toEqual(portalIt);
  });
});
