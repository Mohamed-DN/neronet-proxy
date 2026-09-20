import { beforeEach, describe, expect, it } from 'vitest';

import { clearSession, storeSession } from './authToken';
import { getConnectionState, resetConnectionState } from './connection';
import { backoffDelay, createLiveChannel, liveSocketUrl, topicOf, type LiveEvent } from './live';

/** A socket the test drives, standing in for the browser's. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  emitOpen(): void {
    this.onopen?.();
  }

  emitMessage(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  emitClose(): void {
    this.onclose?.();
  }
}

describe('backoffDelay', () => {
  it('grows with the attempt and never returns less than half the ceiling', () => {
    expect(backoffDelay(0, () => 0)).toBe(500);
    expect(backoffDelay(0, () => 1)).toBe(1000);
    expect(backoffDelay(3, () => 0)).toBe(4000);
    expect(backoffDelay(3, () => 1)).toBe(8000);
  });

  it('caps at thirty seconds however many attempts have failed', () => {
    expect(backoffDelay(50, () => 1)).toBe(30_000);
    expect(backoffDelay(50, () => 0)).toBe(15_000);
  });
});

describe('topicOf', () => {
  it.each([
    ['NODE_QUARANTINE', 'nodes'],
    ['node:updated', 'nodes'],
    ['peering:revoked', 'peering'],
    ['NODE_DELETE', 'nodes']
  ])('maps %s to %s', (event, topic) => {
    expect(topicOf({ event } as LiveEvent)).toBe(topic);
  });

  it('maps the greeting frame and anything unknown to no topic', () => {
    expect(topicOf({ type: 'CONNECTED' })).toBeNull();
    expect(topicOf({ event: 'SOMETHING_ELSE' })).toBeNull();
    expect(topicOf({})).toBeNull();
  });
});

describe('liveSocketUrl', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('is null without a session, so no socket is opened before sign-in', () => {
    expect(liveSocketUrl('/ws/topology', null)).toBeNull();
  });

  it('carries the token on the same origin the document came from', () => {
    const url = liveSocketUrl('/ws/topology', 'tok en/1');
    expect(url).toBe(`ws://${window.location.host}/ws/topology?token=tok%20en%2F1`);
  });
});

describe('createLiveChannel', () => {
  beforeEach(() => {
    localStorage.clear();
    resetConnectionState();
    FakeSocket.instances = [];
  });

  function channelUnderTest(random = () => 0) {
    const timers: { fn: () => void; ms: number }[] = [];
    const channel = createLiveChannel({
      createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
      setTimer: (fn, ms) => timers.push({ fn, ms }) - 1,
      clearTimer: () => {},
      random
    });
    return { channel, timers };
  }

  it('opens no socket and stays idle without a session', () => {
    const { channel } = channelUnderTest();
    channel.start();

    expect(FakeSocket.instances).toHaveLength(0);
    expect(getConnectionState().status).toBe('unknown');
    channel.stop();
  });

  it('reports the connection online once the socket opens', () => {
    storeSession({ token: 'tok' });
    const { channel } = channelUnderTest();
    channel.start();

    FakeSocket.instances[0]?.emitOpen();

    expect(getConnectionState().status).toBe('online');
    channel.stop();
    clearSession();
  });

  it('hands parsed events to its subscribers and ignores unparsable frames', () => {
    storeSession({ token: 'tok' });
    const { channel } = channelUnderTest();
    const seen: LiveEvent[] = [];
    channel.subscribe((event) => seen.push(event));
    channel.start();

    const socket = FakeSocket.instances[0] as FakeSocket;
    socket.emitOpen();
    socket.emitMessage({ event: 'NODE_UPDATE', node_id: 'n1' });
    socket.onmessage?.({ data: 'not json' } as MessageEvent);

    expect(seen).toEqual([{ event: 'NODE_UPDATE', node_id: 'n1' }]);
    channel.stop();
    clearSession();
  });

  it('marks the connection degraded and retries with backoff after a close', () => {
    storeSession({ token: 'tok' });
    const { channel, timers } = channelUnderTest(() => 0);
    channel.start();

    const first = FakeSocket.instances[0] as FakeSocket;
    first.emitOpen();
    expect(getConnectionState().status).toBe('online');

    first.emitClose();

    expect(getConnectionState().status).toBe('degraded');
    expect(getConnectionState().reconnectingInMs).toBe(500);
    expect(timers).toHaveLength(1);

    timers[0]?.fn();
    expect(FakeSocket.instances).toHaveLength(2);

    // The second attempt fails too, and waits longer than the first.
    (FakeSocket.instances[1] as FakeSocket).emitClose();
    expect(timers[1]?.ms).toBe(1000);

    channel.stop();
    clearSession();
  });

  it('does not reconnect after stop()', () => {
    storeSession({ token: 'tok' });
    const { channel, timers } = channelUnderTest();
    channel.start();
    const socket = FakeSocket.instances[0] as FakeSocket;
    socket.emitOpen();

    channel.stop();

    expect(socket.closed).toBe(true);
    expect(timers).toHaveLength(0);
    expect(getConnectionState().status).toBe('unknown');
    clearSession();
  });
});
