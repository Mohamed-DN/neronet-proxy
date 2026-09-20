import { beforeEach, describe, expect, it } from 'vitest';

import {
  getConnectionState,
  reportServerAnswered,
  reportSocketClosed,
  reportSocketIdle,
  reportSocketOpen,
  reportTransportFailure,
  resetConnectionState,
  subscribeToConnection
} from './connection';

describe('connection status', () => {
  beforeEach(() => {
    resetConnectionState();
  });

  it('starts unknown, before anything has been attempted', () => {
    expect(getConnectionState().status).toBe('unknown');
  });

  it('is online when requests succeed and the socket is open', () => {
    reportServerAnswered(200);
    reportSocketOpen();
    expect(getConnectionState().status).toBe('online');
  });

  it('is degraded when requests succeed but the live channel is down', () => {
    reportServerAnswered(200);
    reportSocketClosed(2_000);
    expect(getConnectionState()).toMatchObject({ status: 'degraded', reconnectingInMs: 2_000 });
  });

  it('is degraded when the server answers 5xx, keeping the message', () => {
    reportServerAnswered(503, 'upstream database is down');
    expect(getConnectionState()).toMatchObject({ status: 'degraded', lastError: 'upstream database is down' });
  });

  it('is offline when the request never reached a server', () => {
    reportSocketOpen();
    reportTransportFailure('Failed to fetch');
    expect(getConnectionState()).toMatchObject({ status: 'offline', lastError: 'Failed to fetch' });
  });

  it('clears the failure once a request gets through again', () => {
    reportTransportFailure('Failed to fetch');
    reportServerAnswered(200);
    reportSocketOpen();
    expect(getConnectionState()).toMatchObject({ status: 'online', lastError: null });
  });

  it('treats a 4xx as proof the server answered, not as a connectivity fault', () => {
    reportSocketOpen();
    reportServerAnswered(403);
    expect(getConnectionState().status).toBe('online');
  });

  it('notifies subscribers on every change and stops after unsubscribe', () => {
    const seen: string[] = [];
    const unsubscribe = subscribeToConnection((state) => seen.push(state.status));

    reportServerAnswered(200);
    reportSocketOpen();
    unsubscribe();
    reportTransportFailure('gone');

    expect(seen).toEqual(['unknown', 'online']);
  });

  it('parks the socket fact when the channel is deliberately stopped', () => {
    reportServerAnswered(200);
    reportSocketClosed(1_000);
    expect(getConnectionState().status).toBe('degraded');

    reportSocketIdle();
    expect(getConnectionState()).toMatchObject({ status: 'online', reconnectingInMs: null });
  });
});
