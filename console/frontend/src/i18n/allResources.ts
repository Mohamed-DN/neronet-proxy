/*
 * Every namespace, eagerly, for the Vitest environment only. Tests stay
 * synchronous and deterministic when nothing is fetched on demand; production
 * never imports this module, so none of these files reach the bundle.
 */
const enFiles = import.meta.glob('./locales/en/*.json', { eager: true, import: 'default' }) as Record<
  string,
  Record<string, unknown>
>;
const itFiles = import.meta.glob('./locales/it/*.json', { eager: true, import: 'default' }) as Record<
  string,
  Record<string, unknown>
>;

function namespaceOf(path: string): string {
  return path
    .split('/')
    .pop()!
    .replace(/\.json$/, '');
}

function toResources(files: Record<string, Record<string, unknown>>) {
  return Object.fromEntries(Object.entries(files).map(([path, json]) => [namespaceOf(path), json]));
}

export const allResources = {
  en: toResources(enFiles),
  it: toResources(itFiles)
};
