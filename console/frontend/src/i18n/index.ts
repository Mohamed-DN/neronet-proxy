import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import { LANGUAGE_STORAGE_KEY } from '../ui/tokens';

export const LANGUAGES = ['en', 'it'] as const;
export type Language = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = 'en';

type LocaleFile = Record<string, unknown>;

/*
 * Namespaces follow the areas of the console. `ui` belongs to the primitives
 * and is loaded everywhere; `chrome` is the shell around the pages. Every file
 * in locales/<lang>/ is a namespace named after the file, so a page area adds
 * its keys by adding a file and never edits this module. A key a page namespace
 * lacks falls back to `ui`.
 */
const enFiles = import.meta.glob('./locales/en/*.json', { eager: true, import: 'default' }) as Record<
  string,
  LocaleFile
>;
const itFiles = import.meta.glob('./locales/it/*.json', { eager: true, import: 'default' }) as Record<
  string,
  LocaleFile
>;

function namespaceOf(path: string): string {
  return path
    .split('/')
    .pop()!
    .replace(/\.json$/, '');
}

function toResources(files: Record<string, LocaleFile>): Record<string, LocaleFile> {
  return Object.fromEntries(Object.entries(files).map(([path, json]) => [namespaceOf(path), json]));
}

export const NAMESPACES: string[] = Object.keys(enFiles).map(namespaceOf).sort();

const resources = {
  en: toResources(enFiles),
  it: toResources(itFiles)
};

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

export function initI18n(language: Language = detectLanguage()) {
  if (!i18n.isInitialized) {
    void i18n.use(initReactI18next).init({
      resources,
      lng: language,
      fallbackLng: DEFAULT_LANGUAGE,
      ns: NAMESPACES,
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
