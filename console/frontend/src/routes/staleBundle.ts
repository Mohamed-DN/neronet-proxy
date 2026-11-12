/**
 * After a deploy, a tab that was already open still runs the old JavaScript and
 * asks for page chunks under their old hashed names, which no longer exist. The
 * browser then refuses the import and the page showed "cannot draw this page"
 * until the person pressed Retry (owner report, 12 November 2026). One reload
 * fetches the new index and fixes it, so do that once, automatically; a second
 * failure within a minute is a real problem and shows the error page.
 */
const KEY = 'neronet.staleBundleReloadAt';
const WINDOW_MS = 60_000;

const PATTERNS = [
  /failed to fetch dynamically imported module/i,
  /importing a module script failed/i,
  /error loading dynamically imported module/i,
  /is not a valid javascript mime type/i,
  /unable to preload css/i
];

export function isStaleBundleError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return PATTERNS.some((p) => p.test(error.message));
}

interface ReloadDeps {
  storage?: Storage | null;
  reload?: () => void;
  now?: number;
}

function safeStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Reloads the page unless it already did so for a stale bundle in the last minute. */
export function reloadOnceForStaleBundle({
  storage = safeStorage(),
  reload = () => window.location.reload(),
  now = Date.now()
}: ReloadDeps = {}): boolean {
  let last = 0;
  try {
    last = Number(storage?.getItem(KEY) ?? 0) || 0;
  } catch {
    last = 0;
  }
  if (last && now - last < WINDOW_MS) return false;
  try {
    storage?.setItem(KEY, String(now));
  } catch {
    // A browser that refuses storage still gets its one reload.
  }
  reload();
  return true;
}

/** Vite fires this event when a chunk's preload fails; reload instead of crashing. */
export function installStaleBundleReload(target: Window = window): void {
  target.addEventListener('vite:preloadError', (event) => {
    if (reloadOnceForStaleBundle()) event.preventDefault();
  });
}
