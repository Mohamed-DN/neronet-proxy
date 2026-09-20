/**
 * The five states every data surface in the console can be in.
 *
 * The distinction that matters here is between a value that is zero and a value
 * that was never reported. The control plane knows about things it has never
 * measured - a node's disk encryption, a circuit count, a throughput figure -
 * and the console has shown plausible constants in their place before. A
 * surface that cannot tell the two apart lies to an operator.
 *
 *  loading          the request is in flight; nothing is known yet
 *  empty            the request answered, and the answer is "none"
 *  error            the request failed; the operator can retry
 *  not-measured     the thing exists, and no measurement of it has arrived
 *  not-implemented  the feature is absent or behind a flag that is off
 *
 * `ok` is the sixth: there is data, and it is shown.
 */
export type DataState = 'ok' | 'loading' | 'empty' | 'error' | 'not-measured' | 'not-implemented';

/** Semantic colour role each state is drawn in. Fixed here, not per page. */
export const STATE_ROLE: Record<DataState, 'success' | 'info' | 'warning' | 'danger' | 'muted'> = {
  ok: 'success',
  loading: 'muted',
  empty: 'muted',
  error: 'danger',
  'not-measured': 'info',
  'not-implemented': 'muted'
};

/** i18n key for the short label of each state, in the `ui` namespace. */
export const STATE_LABEL_KEY: Record<DataState, string> = {
  ok: 'state.ok',
  loading: 'state.loading',
  empty: 'state.empty',
  error: 'state.error',
  'not-measured': 'state.notMeasured',
  'not-implemented': 'state.notImplemented'
};

/**
 * Classifies a value a page is about to render.
 *
 * `null` and `undefined` are "never reported" and must never be drawn as 0.
 * `NaN` is the same thing arriving through arithmetic on a missing value.
 */
export function stateOf(value: unknown): 'ok' | 'not-measured' {
  if (value === null || value === undefined) return 'not-measured';
  if (typeof value === 'number' && Number.isNaN(value)) return 'not-measured';
  return 'ok';
}

/** True when the value must be shown as "not measured" rather than as itself. */
export function isNotMeasured(value: unknown): boolean {
  return stateOf(value) === 'not-measured';
}
