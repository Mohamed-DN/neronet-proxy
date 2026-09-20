import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import enUi from './locales/en/ui.json';
import enChrome from './locales/en/chrome.json';
import itUi from './locales/it/ui.json';
import itChrome from './locales/it/chrome.json';

import { LANGUAGE_STORAGE_KEY } from '../ui/tokens';

export const LANGUAGES = ['en', 'it'] as const;
export type Language = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = 'en';

/*
 * Namespaces follow the areas of the console. `ui` belongs to the primitives
 * and is loaded everywhere; `chrome` is the shell around the pages. Each page
 * area gets its own namespace when its own work package translates it, so a
 * translator never has to open one file that holds the whole product.
 */
export const NAMESPACES = ['ui', 'chrome'] as const;

const resources = {
  en: { ui: enUi, chrome: enChrome },
  it: { ui: itUi, chrome: itChrome }
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
