/**
 * The live update channel.
 *
 * The control plane publishes node, risk and peering events on
 * `/ws/topology`. Before this the console opened that socket in one page and
 * dropped the events; every other page polled on its own timer. One channel now
 * holds the socket, reconnects with backoff, reports its state to the
 * connection indicator, and hands each event to whoever is listening - in
 * practice the query cache, which invalidates what the event touched.
 *
 * Authentication reuses what `console/backend/ws/topologyServer.js` already
 * accepts. A browser cannot set an Authorization header on a WebSocket, and the
 * server reads `Sec-WebSocket-Protocol` without echoing a selected subprotocol
 * back, which browsers treat as a failed handshake. That leaves `?token=`.
 */

import { readAccessToken } from './authToken';
import { reportSocketClosed, reportSocketIdle, reportSocketOpen } from './connection';

export interface LiveEvent {
  /** 'NODE_UPDATE', 'node:quarantined', 'peering:revoked', ... */
  event?: string;
  /** The greeting frame uses `type`. */
  type?: string;
  node_id?: string;
  user_id?: string;
  [key: string]: unknown;
}

/** What a page or the query cache does with an event. */
export type LiveListener = (event: LiveEvent) => void;

export interface LiveChannelOptions {
  /** Defaults to `/ws/topology` on this origin. */
  path?: string;
  /** Injected in tests. */
  createSocket?: (url: string) => WebSocket;
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
  random?: () => number;
}

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

/**
 * Equal jitter: half the backoff, plus a random half. Full jitter can return a
 * delay near zero, which turns a control plane restart into a reconnect storm
 * from every open console at once.
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

export function liveSocketUrl(path = '/ws/topology', token: string | null = readAccessToken()): string | null {
  if (!token) return null;
  if (typeof window === 'undefined') return null;
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}${path}?token=${encodeURIComponent(token)}`;
}

export interface LiveChannel {
  /** Open the socket, or reopen it after the token changed. */
  start(): void;
  /** Close it and stop reconnecting. */
  stop(): void;
  subscribe(listener: LiveListener): () => void;
}

export function createLiveChannel(options: LiveChannelOptions = {}): LiveChannel {
  const {
    path = '/ws/topology',
    createSocket = (url: string) => new WebSocket(url),
    setTimer = (fn, ms) => window.setTimeout(fn, ms),
    clearTimer = (handle) => window.clearTimeout(handle),
    random = Math.random
  } = options;

  const listeners = new Set<LiveListener>();
  let socket: WebSocket | null = null;
  let retryHandle: number | null = null;
  let attempt = 0;
  let running = false;

  function cancelRetry(): void {
    if (retryHandle !== null) {
      clearTimer(retryHandle);
      retryHandle = null;
    }
  }

  function scheduleRetry(): void {
    if (!running) return;
    const delay = backoffDelay(attempt, random);
    attempt += 1;
    reportSocketClosed(delay);
    retryHandle = setTimer(() => {
      retryHandle = null;
      open();
    }, delay);
  }

  function open(): void {
    if (!running) return;
    const url = liveSocketUrl(path);
    if (!url) {
      // No session, so no channel. Not a failure, and not something to show as
      // a degraded connection.
      reportSocketIdle();
      return;
    }

    let ws: WebSocket;
    try {
      ws = createSocket(url);
    } catch {
      scheduleRetry();
      return;
    }
    socket = ws;

    ws.onopen = () => {
      attempt = 0;
      reportSocketOpen();
    };

    ws.onmessage = (message: MessageEvent) => {
      let parsed: LiveEvent;
      try {
        parsed = JSON.parse(String(message.data)) as LiveEvent;
      } catch {
        // A frame the console cannot read is not a reason to drop the channel.
        return;
      }
      for (const listener of listeners) {
        try {
          listener(parsed);
        } catch (err) {
          console.error('live listener failed', err);
        }
      }
    };

    ws.onerror = () => {
      // onclose always follows, and carries the decision to retry.
    };

    ws.onclose = () => {
      if (socket === ws) socket = null;
      scheduleRetry();
    };
  }

  return {
    start() {
      if (running) {
        // A restart after the token changed: drop the old socket first.
        stopSocket();
      }
      running = true;
      attempt = 0;
      open();
    },
    stop() {
      running = false;
      cancelRetry();
      stopSocket();
      reportSocketIdle();
    },
    subscribe(listener: LiveListener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };

  function stopSocket(): void {
    cancelRetry();
    const ws = socket;
    socket = null;
    if (ws) {
      // Dropped before closing: onclose would otherwise schedule a reconnect
      // for a channel that was deliberately stopped.
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.onopen = null;
      try {
        ws.close();
      } catch {
        // Already closing.
      }
    }
  }
}

export type LiveTopic = 'nodes' | 'risk' | 'peering' | 'acl' | 'nuke' | null;

/**
 * Which resource an event touched.
 *
 * The control plane names its events in two styles - 'NODE_QUARANTINE' from the
 * routes, 'node:quarantined' from the engines - and both reach this socket.
 */
export function topicOf(event: LiveEvent): LiveTopic {
  const name = String(event.event ?? event.type ?? '').toLowerCase();
  if (name === '' || name === 'connected' || name === 'pong') return null;
  if (name.startsWith('node')) return 'nodes';
  if (name.startsWith('risk')) return 'risk';
  if (name.startsWith('peering')) return 'peering';
  if (name.startsWith('acl')) return 'acl';
  if (name.startsWith('nuke')) return 'nuke';
  return null;
}
