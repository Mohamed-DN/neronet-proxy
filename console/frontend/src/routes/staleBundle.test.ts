import { describe, expect, it, vi } from 'vitest';
import { isStaleBundleError, reloadOnceForStaleBundle } from './staleBundle';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => Array.from(data.keys())[i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v))
  };
}

describe('a page chunk that no longer exists after a deploy', () => {
  it('recognises the errors browsers raise for a missing or non-JS module', () => {
    expect(
      isStaleBundleError(new TypeError('Failed to fetch dynamically imported module: https://x/assets/a.js'))
    ).toBe(true);
    expect(isStaleBundleError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isStaleBundleError(new Error('error loading dynamically imported module'))).toBe(true);
    expect(isStaleBundleError(new Error("'text/html' is not a valid JavaScript MIME type."))).toBe(true);
  });

  it('leaves every other error to the error page', () => {
    expect(isStaleBundleError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isStaleBundleError(null)).toBe(false);
    expect(isStaleBundleError('Failed to fetch')).toBe(false);
  });

  it('reloads once, then lets a second failure within a minute show the error page', () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    expect(reloadOnceForStaleBundle({ storage, reload, now: 1_000 })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reloadOnceForStaleBundle({ storage, reload, now: 30_000 })).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads again for a later deploy', () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    reloadOnceForStaleBundle({ storage, reload, now: 1_000 });
    expect(reloadOnceForStaleBundle({ storage, reload, now: 1_000 + 120_000 })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('still reloads when the browser refuses storage', () => {
    const storage = memoryStorage();
    storage.getItem = () => {
      throw new Error('denied');
    };
    const reload = vi.fn();
    expect(reloadOnceForStaleBundle({ storage, reload, now: 5 })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
