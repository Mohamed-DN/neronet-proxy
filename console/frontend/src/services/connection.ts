/**
 * Whether the console is talking to the control plane, and how well.
 *
 * Two independent facts feed one status. The request layer knows whether the
 * last call reached the server; the live channel knows whether updates are
 * arriving. A console whose requests succeed but whose socket is down is not
 * offline and is not healthy either: it shows what it last fetched and will not
 * notice a node going away until the next poll. That is `degraded`, and it is a
 * distinct fact from `offline`, which means nothing is getting through.
 */

export type ConnectionStatus = 'unknown' | 'online' | 'degraded' | 'offline';

type ApiFact = 'unknown' | 'ok' | 'server-error' | 'unreachable';
type SocketFact = 'unknown' | 'open' | 'closed';

export interface ConnectionState {
  status: ConnectionStatus;
  /** The last failure, verbatim. An operator needs the real message. */
  lastError: string | null;
  /** Set while the live channel is waiting to retry. */
  reconnectingInMs: number | null;
}

const listeners = new Set<(state: ConnectionState) => void>();

let apiFact: ApiFact = 'unknown';
let socketFact: SocketFact = 'unknown';
let lastError: string | null = null;
let reconnectingInMs: number | null = null;
let snapshot: ConnectionState = { status: 'unknown', lastError: null, reconnectingInMs: null };

function derive(): ConnectionStatus {
  if (apiFact === 'unreachable') return 'offline';
  if (apiFact === 'server-error') return 'degraded';
  // A socket that opened and then dropped is a fact on its own: updates are not
  // arriving, whether or not a request has been tried since.
  if (socketFact === 'closed') return 'degraded';
  if (apiFact === 'ok') return 'online';
  // Nothing has been attempted yet. A socket that opened is proof the origin
  // answers.
  return socketFact === 'open' ? 'online' : 'unknown';
}

function publish(): void {
  const next: ConnectionState = { status: derive(), lastError, reconnectingInMs };
  if (
    next.status === snapshot.status &&
    next.lastError === snapshot.lastError &&
    next.reconnectingInMs === snapshot.reconnectingInMs
  ) {
    return;
  }
  snapshot = next;
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch (err) {
      // A broken subscriber must not take down the request that triggered it.
      console.error('connection listener failed', err);
    }
  }
}

export function getConnectionState(): ConnectionState {
  return snapshot;
}

export function subscribeToConnection(listener: (state: ConnectionState) => void): () => void {
  listeners.add(listener);
  listener(snapshot);
  return () => {
    listeners.delete(listener);
  };
}

/** A request completed with an HTTP status, whatever that status was. */
export function reportServerAnswered(status: number, message?: string): void {
  if (status >= 500) {
    apiFact = 'server-error';
    lastError = message ?? `HTTP ${status}`;
  } else {
    apiFact = 'ok';
    lastError = null;
  }
  publish();
}

/** The request never reached a server: DNS, refused connection, cut cable. */
export function reportTransportFailure(message: string): void {
  apiFact = 'unreachable';
  lastError = message;
  publish();
}

export function reportSocketOpen(): void {
  socketFact = 'open';
  reconnectingInMs = null;
  publish();
}

export function reportSocketClosed(retryInMs: number | null): void {
  socketFact = 'closed';
  reconnectingInMs = retryInMs;
  publish();
}

/** The live channel is deliberately not running, for instance before sign-in. */
export function reportSocketIdle(): void {
  socketFact = 'unknown';
  reconnectingInMs = null;
  publish();
}

/** Test seam. Not called by the product. */
export function resetConnectionState(): void {
  apiFact = 'unknown';
  socketFact = 'unknown';
  lastError = null;
  reconnectingInMs = null;
  snapshot = { status: 'unknown', lastError: null, reconnectingInMs: null };
}
