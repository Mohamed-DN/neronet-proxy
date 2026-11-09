import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from './client';
import { useCreateRegistrationKey, useRegisterProfileDevice, useSetProfileGateway } from './devices';

function wrapperWith() {
  const client = createQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  return { client, wrapper };
}

function stubFetch(answer: unknown) {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof stubFetch>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('device hooks', () => {
  it('register posts only name, public_key and preshared_key', async () => {
    const fetchMock = stubFetch({ device_id: 'dev-1', name: 'Work phone' });
    const { wrapper } = wrapperWith();
    const { result } = renderHook(() => useRegisterProfileDevice(), { wrapper });

    result.current.mutate({ name: 'Work phone', public_key: 'PUB=', preshared_key: 'PSK=' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/devices\/profile$/);
    expect(Object.keys(sentBody(fetchMock)).sort()).toEqual(['name', 'preshared_key', 'public_key']);
    expect(sentBody(fetchMock)).toEqual({ name: 'Work phone', public_key: 'PUB=', preshared_key: 'PSK=' });
  });

  it('set gateway puts the node and endpoint it names', async () => {
    const fetchMock = stubFetch({ gateway: { node_id: 'n1', public_key: 'G=', endpoint: 'gw:51820' } });
    const { wrapper } = wrapperWith();
    const { result } = renderHook(() => useSetProfileGateway(), { wrapper });

    result.current.mutate({ node_id: 'n1', endpoint: 'gw:51820' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('PUT');
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/devices\/gateway$/);
    expect(sentBody(fetchMock)).toEqual({ node_id: 'n1', endpoint: 'gw:51820' });
  });

  it('create registration key asks for a single-use key valid for 24 hours', async () => {
    const fetchMock = stubFetch({ id: 'k1', enrolment_string: 'neronet://enrol' });
    const { wrapper } = wrapperWith();
    const { result } = renderHook(() => useCreateRegistrationKey(), { wrapper });

    result.current.mutate();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/preauth-keys$/);
    expect(sentBody(fetchMock)).toEqual({ expires_in_hours: 24, is_reusable: false });
  });
});
