/**
 * Browser-v2 session coordination (see console/backend/services/BrowserContextService.js).
 *
 * The control plane keeps the authority: a durable browser context bound to an
 * opaque HttpOnly cookie, monotonic intents, and one selected issuance whose
 * credentials live only in HttpOnly cookies named for it. A late response may
 * still deliver cookies for a superseded sign-in; they grant nothing, because
 * every request names the issuance this document believes is selected and the
 * server authenticates only its own selection.
 *
 * This module stores non-secret coordination state only: the context id, the
 * last intent this browser allocated, the selected issuance selector and a
 * logout tombstone. Never a password, token or MFA proof. IndexedDB keeps it
 * across reloads (localStorage when IndexedDB is unavailable); Web Locks
 * serialise bootstrap and intent allocation between tabs where supported. The
 * server still orders intents itself, so a missing store degrades to "start
 * after the server's latest intent", never to adopting a stale session.
 */

export const BROWSER_PROTOCOL = import.meta.env.VITE_BROWSER_PROTOCOL === '2' ? '2' : null;

export interface Selection {
  sid: string;
  issuance_id: string;
}

interface ContextRecord {
  contextId: string;
  intent: string; // canonical decimal, uint64
  selected: Selection | null;
  /** Issuance this browser signed out of locally; never resumed even if the server still names it. */
  tombstone?: string | null;
  /** The server selection hidden by the tombstone: the predecessor a new intent must expect. */
  hidden?: Selection | null;
}

export interface BrowserOperation {
  operation_id: string;
  intent: string;
  kind: 'login' | 'register' | 'mfa' | 'refresh' | 'lock' | 'unlock' | 'logout';
  expected_issuance_id: string | null;
  successor_issuance_id: string | null;
}

interface ContextSnapshot {
  context_id: string;
  latest_intent: string;
  selected: Selection | null;
}

const DB_NAME = 'neronet-browser';
const STORE = 'context';
const KEY = 'current';
const FALLBACK_KEY = 'neronet-browser-context';
const LOCK = 'neronet-browser-intent';
const OPEN_TIMEOUT_MS = 3000;

let memoryRecord: ContextRecord | null = null;
let current: ContextRecord | null = null;
let ready: Promise<ContextRecord> | null = null;
// The session family this document adopted. A server selection of another
// family is a different principal and is never adopted silently.
let adopted: Selection | null = null;

function openStore(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (db: IDBDatabase | null) => {
      if (settled) {
        db?.close();
        return;
      }
      settled = true;
      resolve(db);
    };
    // A hung or blocked open must not stall every request of the console.
    const timer = setTimeout(() => finish(null), OPEN_TIMEOUT_MS);
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => {
        clearTimeout(timer);
        request.result.onversionchange = () => request.result.close();
        finish(request.result);
      };
      request.onerror = () => {
        clearTimeout(timer);
        finish(null);
      };
      request.onblocked = () => {
        clearTimeout(timer);
        finish(null);
      };
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
}

function readFallback(): ContextRecord | null {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(FALLBACK_KEY) : null;
    return raw ? (JSON.parse(raw) as ContextRecord) : memoryRecord;
  } catch {
    return memoryRecord;
  }
}

function writeFallback(record: ContextRecord): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(FALLBACK_KEY, JSON.stringify(record));
  } catch {
    // Storage disabled: the in-memory copy is all this document has.
  }
}

async function readRecord(): Promise<ContextRecord | null> {
  const db = await openStore();
  if (!db) return readFallback();
  return new Promise((resolve) => {
    try {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      request.onsuccess = () => resolve((request.result as ContextRecord | undefined) ?? null);
      request.onerror = () => resolve(readFallback());
    } catch {
      resolve(readFallback());
    }
  }).finally(() => db.close()) as Promise<ContextRecord | null>;
}

async function writeRecord(record: ContextRecord): Promise<void> {
  const db = await openStore();
  if (!db) {
    writeFallback(record);
  } else {
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readwrite');
        transaction.objectStore(STORE).put(record, KEY);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    } finally {
      db.close();
    }
  }
  // Memory follows the durable write, never precedes it.
  memoryRecord = record;
  current = record;
}

function withIntentLock<T>(work: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  return locks ? (locks.request(LOCK, work) as Promise<T>) : work();
}

const larger = (a: string, b: string) => (BigInt(a) >= BigInt(b) ? a : b);

function protocolHeaders(contextId: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-NeroNet-Browser-Protocol': '2',
    'X-NeroNet-Browser-Context': contextId
  };
}

async function postContext(contextId: string): Promise<Response> {
  return fetch('/api/auth/browser/context', {
    method: 'POST',
    credentials: 'same-origin',
    headers: protocolHeaders(contextId),
    body: JSON.stringify({ context_id: contextId })
  });
}

function reconcile(stored: ContextRecord | null, contextId: string, snapshot: ContextSnapshot): ContextRecord {
  const tombstone = stored?.tombstone ?? null;
  const hidden = snapshot.selected && snapshot.selected.issuance_id === tombstone ? snapshot.selected : null;
  const selected = hidden ? null : snapshot.selected;
  return {
    contextId,
    intent: stored ? larger(stored.intent, snapshot.latest_intent) : snapshot.latest_intent,
    selected,
    tombstone: selected ? null : tombstone,
    hidden
  };
}

/**
 * Bind (or re-read) this browser's context, under the cross-tab lock so that two
 * tabs opened at once agree on one context. A context whose binding cookie was
 * lost cannot be recovered from its public id; a new one is created instead.
 */
function establish(): Promise<ContextRecord> {
  return withIntentLock(async () => {
    const stored = await readRecord();
    if (stored) {
      const response = await postContext(stored.contextId);
      if (response.ok) {
        const record = reconcile(stored, stored.contextId, (await response.json()) as ContextSnapshot);
        await writeRecord(record);
        return record;
      }
      if (response.status >= 500 || response.status === 429)
        throw new Error(`Browser context unavailable (HTTP ${response.status})`);
    }
    const contextId = crypto.randomUUID();
    const response = await postContext(contextId);
    if (!response.ok) throw new Error(`Browser context could not be created (HTTP ${response.status})`);
    const record = reconcile(null, contextId, (await response.json()) as ContextSnapshot);
    await writeRecord(record);
    return record;
  });
}

/** The current record, after this document bound its context. */
export async function ensureBrowserContext(): Promise<ContextRecord> {
  if (!ready) {
    ready = establish().catch((error) => {
      ready = null;
      throw error;
    });
  }
  await ready;
  return current!;
}

/** Re-read the server selection (after a reload or a 409 from another document). */
export async function resyncBrowserContext(): Promise<Selection | null> {
  ready = null;
  return (await ensureBrowserContext()).selected;
}

/** Headers of every v2 request: the context and the issuance this document uses. */
export function browserHeaders(issuanceId: string | null): Record<string, string> {
  if (!current) return {};
  return {
    'X-NeroNet-Browser-Protocol': '2',
    'X-NeroNet-Browser-Context': current.contextId,
    ...(issuanceId ? { 'X-NeroNet-Browser-Issuance': issuanceId } : {})
  };
}

/**
 * Allocate and admit the next intent before the operation it describes. The
 * intent is persisted first, so a reload cannot reuse it.
 */
export async function beginBrowserOperation(
  kind: BrowserOperation['kind'],
  expected: string | null
): Promise<BrowserOperation> {
  await ensureBrowserContext();
  const operation = await withIntentLock(async () => {
    const stored = await readRecord();
    const base = stored && stored.contextId === current!.contextId ? stored : current!;
    const next = (BigInt(larger(base.intent, current!.intent)) + 1n).toString();
    await writeRecord({ ...base, intent: next });
    return {
      operation_id: crypto.randomUUID(),
      intent: next,
      kind,
      expected_issuance_id: expected,
      successor_issuance_id: kind === 'logout' ? null : crypto.randomUUID()
    } satisfies BrowserOperation;
  });
  const response = await fetch('/api/auth/browser/intent', {
    method: 'POST',
    credentials: 'same-origin',
    headers: protocolHeaders(current!.contextId),
    body: JSON.stringify(operation)
  });
  if (!response.ok) {
    if (response.status === 409) await resyncBrowserContext();
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw Object.assign(new Error(body?.error || `Browser intent refused (HTTP ${response.status})`), {
      status: response.status
    });
  }
  return operation;
}

/** True while no later intent was allocated by this browser (any tab). */
export async function isLatestOperation(operation: BrowserOperation): Promise<boolean> {
  const record = (await readRecord()) ?? current;
  return Boolean(record && record.intent === operation.intent);
}

/** Compare-and-set adoption of a login candidate. */
export async function selectCandidate(operation: BrowserOperation): Promise<Selection> {
  const response = await fetch('/api/auth/browser/select', {
    method: 'POST',
    credentials: 'same-origin',
    headers: protocolHeaders(current!.contextId),
    body: JSON.stringify({
      operation_id: operation.operation_id,
      intent: operation.intent,
      issuance_id: operation.successor_issuance_id
    })
  });
  const body = (await response.json().catch(() => null)) as { selected?: Selection; error?: string } | null;
  if (!response.ok || !body?.selected) {
    await resyncBrowserContext();
    throw Object.assign(new Error(body?.error || `Browser selection refused (HTTP ${response.status})`), {
      status: response.status
    });
  }
  await rememberSelection(body.selected);
  return body.selected;
}

/**
 * The issuance a new intent must name as its predecessor: the server's selection,
 * including one hidden by a local sign-out the server never received.
 */
export async function expectedForIntent(): Promise<string | null> {
  const record = await ensureBrowserContext();
  return record.selected?.issuance_id ?? record.hidden?.issuance_id ?? null;
}

export function currentContextId(): string | null {
  return current?.contextId ?? null;
}

/** The selection this document adopted (its session family), if any. */
export function adoptedSelection(): Selection | null {
  return adopted;
}

// One channel per document: BroadcastChannel never delivers a message back to the
// instance that posted it, so a document hears only the other tabs. It invalidates
// views immediately; the server's selection stays the authority.
const CHANNEL = 'neronet-browser-selection';
let channel: BroadcastChannel | null = null;
const foreignListeners = new Set<(selected: Selection | null) => void>();

function selectionChannel(): BroadcastChannel | null {
  if (channel || typeof BroadcastChannel === 'undefined') return channel;
  try {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event: MessageEvent<{ selected?: Selection | null }>) => {
      const selected = event.data?.selected ?? null;
      for (const listener of foreignListeners) listener(selected);
    };
  } catch {
    channel = null;
  }
  return channel;
}

function announce(selected: Selection | null): void {
  try {
    selectionChannel()?.postMessage({ selected });
  } catch {
    // Another tab learns of the change at its next request instead.
  }
}

/** Selections adopted or abandoned by other tabs of this browser. */
export function onForeignSelection(listener: (selected: Selection | null) => void): () => void {
  selectionChannel();
  foreignListeners.add(listener);
  return () => foreignListeners.delete(listener);
}

/** Follow a rotation of this document's own family announced by another tab. */
export function followSelection(selected: Selection): void {
  adopted = selected;
}

/** Record a selection this document adopted (sign-in, refresh, vault rotation). */
export async function rememberSelection(selected: Selection | null): Promise<void> {
  adopted = selected;
  announce(selected);
  if (!current) return;
  const stored = await readRecord();
  const base = stored && stored.contextId === current.contextId ? stored : current;
  await writeRecord({ ...base, selected, tombstone: selected ? null : (base.tombstone ?? null), hidden: null });
}

/**
 * Local sign-out: forget the selection and remember it as a tombstone, so a
 * reload never resumes it even if the server could not be told.
 */
export async function forgetSelection(issuanceId: string | null): Promise<void> {
  adopted = null;
  announce(null);
  if (!current) return;
  const stored = await readRecord();
  const base = stored && stored.contextId === current.contextId ? stored : current;
  await writeRecord({ ...base, selected: null, tombstone: issuanceId ?? base.tombstone ?? null });
}

/** Test hook: forget module state (the stored record is left to the test). */
export function resetBrowserContextForTests(): void {
  memoryRecord = null;
  current = null;
  ready = null;
  adopted = null;
  channel?.close();
  channel = null;
  foreignListeners.clear();
}
