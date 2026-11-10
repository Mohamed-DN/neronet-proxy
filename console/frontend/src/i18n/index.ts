import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import { LANGUAGE_STORAGE_KEY } from '../ui/tokens';

import { lazyLocaleBackend } from './backend';

export const LANGUAGES = ['en', 'it'] as const;
export type Language = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = 'en';

type LocaleFile = Record<string, unknown>;

/*
 * Namespaces follow the areas of the console. `ui` belongs to the primitives
 * and `chrome` is the shell around the pages, which includes the sign-in strings
 * under `login`. Both are bundled with the entry. Every other file in
 * locales/<lang>/ is a namespace named after the file and is fetched the first
 * time a page asks for it (see backend.ts), so a page area adds its keys by
 * adding a file and never edits this module. A key a page namespace lacks falls
 * back to `ui`.
 */
export const EAGER_NAMESPACES = ['chrome', 'ui'] as const;

const eagerFiles = import.meta.glob('./locales/{en,it}/{chrome,ui}.json', {
  eager: true,
  import: 'default'
}) as Record<string, LocaleFile>;

function namespaceOf(path: string): string {
  return path
    .split('/')
    .pop()!
    .replace(/\.json$/, '');
}

const eagerResources = { en: {} as Record<string, LocaleFile>, it: {} as Record<string, LocaleFile> };
for (const [path, json] of Object.entries(eagerFiles)) {
  const lng = path.split('/')[2] as Language;
  eagerResources[lng][namespaceOf(path)] = json;
}

// Every namespace, from the names of the English files. The paths alone are
// needed here, so no locale file is loaded to build this list.
const namespaceFiles = import.meta.glob('./locales/en/*.json');
export const NAMESPACES: string[] = Object.keys(namespaceFiles).map(namespaceOf).sort();

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

/**
 * The language to start in: the stored choice, then the browser's preference if
 * the console speaks it, then English. The browser preference is only a first
 * guess; once the operator picks a language the choice is theirs and is kept.
 */
export function detectLanguage(): Language {
  try {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (isLanguage(stored)) return stored;
  } catch {
    // Storage can be unavailable; the browser preference still applies.
  }
  const preferred = typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language]);
  for (const tag of preferred) {
    const base = String(tag).split('-')[0];
    if (isLanguage(base)) return base;
  }
  return DEFAULT_LANGUAGE;
}

/** Keeps the document in step with the active language for screen readers. */
export function syncDocumentLanguage(language: string): void {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('lang', language);
  }
}

export interface InitOptions {
  /** Every namespace up front, for tests. Production fetches the rest on demand. */
  resources?: Record<Language, Record<string, LocaleFile>>;
}

export function initI18n(language: Language = detectLanguage(), options: InitOptions = {}) {
  if (!i18n.isInitialized) {
    const eagerOnly = options.resources === undefined;
    const instance = i18n.use(initReactI18next);
    if (eagerOnly) instance.use(lazyLocaleBackend);
    void instance.init({
      resources: options.resources ?? eagerResources,
      lng: language,
      fallbackLng: DEFAULT_LANGUAGE,
      ns: eagerOnly ? [...EAGER_NAMESPACES] : NAMESPACES,
      partialBundledLanguages: eagerOnly,
      defaultNS: 'ui',
      fallbackNS: 'ui',
      interpolation: { escapeValue: false },
      returnNull: false
    });
    i18n.on('languageChanged', syncDocumentLanguage);
  }
  syncDocumentLanguage(i18n.language);
  return i18n;
}

export async function setLanguage(language: Language): Promise<void> {
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // The choice still applies to this session.
  }
  await i18n.changeLanguage(language);
}

export default i18n;
