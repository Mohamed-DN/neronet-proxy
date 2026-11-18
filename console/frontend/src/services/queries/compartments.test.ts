import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from './client';
import {
  useMergeCompartment,
  usePreviewMove,
  usePreviewSplit,
  useReorderCompartments,
  useSplitCompartment,
  useUpdateCompartment
} from './compartments';
import { queryKeys } from './keys';

function wrapperWith() {
  const client = createQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  return { client, wrapper };
}

function stubFetch(answer: unknown, status = 200) {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(answer), { status, headers: { 'content-type': 'application/json' } })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const urlOf = (m: ReturnType<typeof stubFetch>) => String(m.mock.calls[0]?.[0]);
const initOf = (m: ReturnType<typeof stubFetch>) => m.mock.calls[0]?.[1] as RequestInit;
const bodyOf = (m: ReturnType<typeof stubFetch>) => JSON.parse(String(initOf(m).body)) as Record<string, unknown>;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('line editing hooks', () => {
  it('update puts only the fields that change and returns the compartment', async () => {
    const line = { id: 'cmp-1', name: 'Lab', line_colour: 'violet', sort_order: 2 };
    const fetchMock = stubFetch({ compartment: line });
    const { wrapper } = wrapperWith();
    const { result } = renderHook(() => useUpdateCompartment(), { wrapper });

    result.current.mutate({ id: 'cmp-1', line_colour: 'violet', sort_order: 2 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(urlOf(fetchMock)).toMatch(/\/compartments\/cmp-1$/);
    expect(initOf(fetchMock).method).toBe('PUT');
    expect(bodyOf(fetchMock)).toEqual({ line_colour: 'violet', sort_order: 2 });
    expect(result.current.data).toEqual(line);
  });

  it('update can send null to clear the colour and encodes the id', async () => {
    const fetchMock = stubFetch({ compartment: { id: 'a/b' } });
    const { wrapper } = wrapperWith();
    const { result } = renderHook(() => useUpdateCompartment(), { wrapper });

    result.current.mutate({ id: 'a/b', line_colour: null });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(urlOf(fetchMock)).toMatch(/\/compartments\/a%2Fb$/);
    expect(bodyOf(fetchMock)).toEqual({ line_colour: null });
  });

  it('a 409 name_in_use reaches the caller as an error', async () => {
    stubFetch({ error: 'name_in_use', message: 'A line with this name already exists' }, 409);
    const { wrapper } = wrapperWith();
    const { result } = renderHook(() => useUpdateCompartment(), { wrapper });

    result.current.mutate({ id: 'cmp-1', name: 'Lab' });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toMatchObject({ status: 409 });
  });

  it('reorder puts the ids in order and returns the list', async () => {
    const fetchMock = stubFetch({ compartments: [{ id: 'b' }, { id: 'a' }] });
    const { wrapper } = wrapperWith();
    const { result } = renderHook(() => useReorderCompartments(), { wrapper });

    result.current.mutate(['b', 'a']);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(urlOf(fetchMock)).toMatch(/\/compartments\/reorder$/);
    expect(initOf(fetchMock).method).toBe('PUT');
    expect(bodyOf(fetchMock)).toEqual({ ids: ['b', 'a'] });
    expect(result.current.data).toEqual([{ id: 'b' }, { id: 'a' }]);
  });

  it('split posts the name and devices, adds the colour only when given, and returns the peerings note', async () => {
    const answer = {
      compartment: { id: 'cmp-new' },
      moved: ['n1'],
      peerings_not_inherited: { count: 2, peers: ['Guests'] }
    };
    const fetchMock = stubFetch(answer, 201);
    const { wrapper } = wrapperWith();
    const { result } = renderHook(() => useSplitCompartment(), { wrapper });

    result.current.mutate({ id: 'cmp-1', name: 'Lab', nodeIds: ['n1'] });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(urlOf(fetchMock)).toMatch(/\/compartments\/cmp-1\/split$/);
    expect(bodyOf(fetchMock)).toEqual({ name: 'Lab', node_ids: ['n1'] });
    expect(result.current.data?.peerings_not_inherited.count).toBe(2);
  });

  it('split sends line_colour when one is chosen', async () => {
    const fetchMock = stubFetch({
      compartment: { id: 'x' },
      moved: [],
      peerings_not_inherited: { count: 0, peers: [] }
    });
    const { wrapper } = wrapperWith();
    const { result } = renderHook(() => useSplitCompartment(), { wrapper });

    result.current.mutate({ id: 'cmp-1', name: 'Lab', nodeIds: ['n1'], lineColour: 'sky' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(bodyOf(fetchMock)).toEqual({ name: 'Lab', node_ids: ['n1'], line_colour: 'sky' });
  });

  it('merge posts the target and returns the dropped peerings', async () => {
    const answer = { compartment: { id: 'into' }, moved: ['n1'], dropped_peerings: { count: 1, peers: ['Guests'] } };
    const fetchMock = stubFetch(answer);
    const { wrapper } = wrapperWith();
    const { result } = renderHook(() => useMergeCompartment(), { wrapper });

    result.current.mutate({ id: 'cmp-1', into: 'into' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(urlOf(fetchMock)).toMatch(/\/compartments\/cmp-1\/merge$/);
    expect(bodyOf(fetchMock)).toEqual({ into: 'into' });
    expect(result.current.data?.dropped_peerings.peers).toEqual(['Guests']);
  });

  it('every write refreshes the compartments, topology and policy views', async () => {
    stubFetch({ compartments: [] });
    const { client, wrapper } = wrapperWith();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useReorderCompartments(), { wrapper });

    result.current.mutate(['a']);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const keys = spy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
    expect(keys).toContain(JSON.stringify(queryKeys.compartments));
    expect(keys).toContain(JSON.stringify(queryKeys.statsTopology));
    expect(keys).toContain(JSON.stringify(queryKeys.acl));
  });

  it('preview-move posts node_ids and to, and refreshes nothing', async () => {
    const answer = {
      nodes: [],
      summary: { nodes_moved: 1, gains: 2, losses: 1 },
      ignored: 0
    };
    const fetchMock = stubFetch(answer);
    const { client, wrapper } = wrapperWith();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => usePreviewMove(), { wrapper });

    result.current.mutate({ nodeIds: ['n1'], to: 'cmp-2' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(urlOf(fetchMock)).toMatch(/\/compartments\/preview-move$/);
    expect(initOf(fetchMock).method).toBe('POST');
    expect(bodyOf(fetchMock)).toEqual({ node_ids: ['n1'], to: 'cmp-2' });
    expect(result.current.data?.summary).toEqual({ nodes_moved: 1, gains: 2, losses: 1 });
    expect(spy).not.toHaveBeenCalled();
  });

  it('preview-split posts node_ids to the source line', async () => {
    const fetchMock = stubFetch({
      nodes: [],
      summary: { nodes_moved: 1, gains: 0, losses: 3 },
      peerings_not_inherited: { count: 1, peers: ['Guests'] }
    });
    const { wrapper } = wrapperWith();
    const { result } = renderHook(() => usePreviewSplit(), { wrapper });

    result.current.mutate({ id: 'cmp-1', nodeIds: ['n1'] });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(urlOf(fetchMock)).toMatch(/\/compartments\/cmp-1\/preview-split$/);
    expect(bodyOf(fetchMock)).toEqual({ node_ids: ['n1'] });
    expect(result.current.data?.peerings_not_inherited?.count).toBe(1);
  });
});
