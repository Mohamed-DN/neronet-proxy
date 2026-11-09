/*
 * The apps the console's operators publish for a person to install. The list
 * comes from one manifest file served beside the console, so nothing in the
 * code names a download address. Until ops publish the manifest, every
 * platform reads "not published yet".
 */

export const PUBLISHED_PLATFORMS = ['android', 'windows', 'macos', 'linux'] as const;
export type PublishedPlatform = (typeof PUBLISHED_PLATFORMS)[number];

export interface PublishedApp {
  platform: PublishedPlatform;
  version: string;
  file: string;
  size_bytes: number;
  sha256: string;
}

export const MANIFEST_PATH = '/downloads/manifest.json';

function isPublishedApp(value: unknown): value is PublishedApp {
  if (typeof value !== 'object' || value === null) return false;
  const app = value as Record<string, unknown>;
  return (
    typeof app.platform === 'string' &&
    (PUBLISHED_PLATFORMS as readonly string[]).includes(app.platform) &&
    typeof app.version === 'string' &&
    typeof app.file === 'string' &&
    typeof app.size_bytes === 'number' &&
    typeof app.sha256 === 'string'
  );
}

/**
 * Reads the manifest. Anything other than a JSON answer in the agreed shape
 * counts as nothing published: a single-page app serves its HTML page for any
 * unknown path, and that HTML is not a list of apps.
 */
export async function fetchPublishedApps(fetchImpl: typeof fetch = fetch): Promise<PublishedApp[]> {
  let res: Response;
  try {
    res = await fetchImpl(MANIFEST_PATH, { headers: { accept: 'application/json' } });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) return [];

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return [];
  }
  if (typeof body !== 'object' || body === null || !Array.isArray((body as { apps?: unknown }).apps)) return [];
  const apps = (body as { apps: unknown[] }).apps;
  return apps.every(isPublishedApp) ? apps : [];
}
