import type { BackendModule } from 'i18next';

type LocaleFile = Record<string, unknown>;

/*
 * One loader per locale file, keyed by its path. Vite emits each file that is
 * not statically imported as its own chunk, so a page namespace costs nothing
 * until a page asks for it.
 */
const loaders = import.meta.glob('./locales/*/*.json', { import: 'default' }) as Record<
  string,
  () => Promise<LocaleFile>
>;

/**
 * Loads one namespace of one language on demand. i18next calls read() when a
 * page asks for a namespace the entry did not bundle; the page suspends until
 * the callback runs.
 */
export const lazyLocaleBackend: BackendModule = {
  type: 'backend',
  init() {},
  read(language, namespace, callback) {
    const load = loaders[`./locales/${language}/${namespace}.json`];
    if (!load) {
      callback(new Error(`no locale file for ${language}/${namespace}`), false);
      return;
    }
    load().then(
      (json) => callback(null, json),
      (error: unknown) => callback(error as Error, false)
    );
  }
};
