import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, apiPost, apiRequest } from '../apiClient';

/**
 * The connection test (ADR 0040).
 *
 * The button asks the control plane to have the device's gateway ping it now, then reads
 * the request until it is answered. Every figure shown comes from that one request: a
 * number stored by an earlier ping is never presented as the result of this test.
 */

/** What the control plane says about one request, or answers at once. */
export interface ProbeAnswer {
  request_id?: string;
  state:
    | 'pending'
    | 'measuring'
    | 'replied'
    | 'no_reply'
    | 'not_connected'
    | 'gateway_unreachable'
    | 'unsupported';
  rtt_ms?: number | null;
  method?: string;
  answered_at?: string;
  last_contact_at?: string | null;
}

/** What the page shows. `rate_limited` and `failed` are this console's own states. */
export type ProbeView =
  | { state: 'measuring' }
  | { state: 'replied'; rttMs: number; answeredAt: string | null }
  | { state: 'no_reply'; lastContactAt: string | null }
  | { state: 'not_connected'; lastContactAt: string | null }
  | { state: 'gateway_unreachable' }
  | { state: 'unsupported' }
  | { state: 'rate_limited' }
  | { state: 'failed' };

/** How often the request is read while it is open. */
export const PROBE_POLL_MS = 400;
/** The control plane expires a request after 30 s; the page gives up a little later. */
export const PROBE_GIVE_UP_MS = 35_000;

function viewOf(answer: ProbeAnswer): ProbeView | null {
  switch (answer.state) {
    case 'pending':
    case 'measuring':
      return null;
    case 'replied':
      return { state: 'replied', rttMs: Number(answer.rtt_ms), answeredAt: answer.answered_at ?? null };
    case 'no_reply':
      return { state: 'no_reply', lastContactAt: answer.last_contact_at ?? null };
    case 'not_connected':
      return { state: 'not_connected', lastContactAt: answer.last_contact_at ?? null };
    case 'gateway_unreachable':
      return { state: 'gateway_unreachable' };
    case 'unsupported':
      return { state: 'unsupported' };
    default:
      return { state: 'failed' };
  }
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });

/**
 * Starts one connection test for `deviceId` and follows it. `view` is null before the
 * first click and whenever the device changes.
 */
export function useConnectionTest(deviceId: string | undefined) {
  const [view, setView] = useState<ProbeView | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    setView(null);
    return () => abort.current?.abort();
  }, [deviceId]);

  const start = useCallback(async () => {
    if (!deviceId) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const base = `/nodes/${encodeURIComponent(deviceId)}/probe`;
    setView({ state: 'measuring' });
    try {
      let answer = await apiPost<ProbeAnswer>(base, {}, { signal: controller.signal });
      const deadline = Date.now() + PROBE_GIVE_UP_MS;
      while (!controller.signal.aborted) {
        const done = viewOf(answer);
        if (done) {
          setView(done);
          return;
        }
        if (Date.now() > deadline || !answer.request_id) {
          setView({ state: 'gateway_unreachable' });
          return;
        }
        await wait(PROBE_POLL_MS, controller.signal);
        if (controller.signal.aborted) return;
        answer = await apiRequest<ProbeAnswer>(`${base}/${encodeURIComponent(answer.request_id)}`, {
          signal: controller.signal
        });
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      setView(err instanceof ApiError && err.status === 429 ? { state: 'rate_limited' } : { state: 'failed' });
    }
  }, [deviceId]);

  return { view, start, running: view?.state === 'measuring' };
}
