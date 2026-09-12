/**
 * Tracks whether the console is showing live control-plane data or mock data.
 *
 * The console previously had no way to tell these apart. A failed request and a
 * successful request over an empty database both arrived downstream as null, and
 * several panels answered by substituting demo fixtures. The result was a UI that
 * looked identical whether the mesh was healthy, the backend was down, or the
 * database was empty -- so "are the real nodes reporting?" could not be answered by
 * looking at the screen, which is the one thing the screen exists for.
 */

const listeners = new Set();

const state = {
  // 'unknown' until the first request completes.
  backend: 'unknown', // 'unknown' | 'reachable' | 'unreachable'
  lastError: null,
  // Endpoints currently being served from fixtures, most recent first.
  mockedEndpoints: []
};

/** Deliver a snapshot to one listener without letting it break the caller. */
function deliver(listener, snapshot) {
  try {
    listener(snapshot);
  } catch (err) {
    // A broken subscriber must not take down the request that triggered it.
    console.error('dataSource listener failed:', err);
  }
}

function notify() {
  const snapshot = getDataSourceState();
  for (const listener of listeners) {
    deliver(listener, snapshot);
  }
}

/** Record that the control plane answered. */
export function markReachable() {
  const changed = state.backend !== 'reachable' || state.mockedEndpoints.length > 0;
  state.backend = 'reachable';
  state.lastError = null;
  state.mockedEndpoints = [];
  if (changed) notify();
}

/** Record that the control plane could not be reached, or returned an error. */
export function markUnreachable(reason) {
  const changed = state.backend !== 'unreachable' || state.lastError !== reason;
  state.backend = 'unreachable';
  state.lastError = reason || 'unknown error';
  if (changed) notify();
}

/** Record that a specific endpoint is being served from fixtures. */
export function markMocked(endpoint) {
  if (!state.mockedEndpoints.includes(endpoint)) {
    state.mockedEndpoints = [endpoint, ...state.mockedEndpoints].slice(0, 20);
    notify();
  }
}

export function getDataSourceState() {
  return {
    backend: state.backend,
    lastError: state.lastError,
    mockedEndpoints: [...state.mockedEndpoints],
    isShowingMockData: state.mockedEndpoints.length > 0
  };
}

/** Subscribe to changes. Returns an unsubscribe function. */
export function subscribeToDataSource(listener) {
  listeners.add(listener);
  // Guarded like every other delivery: a subscriber that throws on its first render
  // should not propagate out of subscribe() and unmount the tree that registered it.
  deliver(listener, getDataSourceState());
  return () => listeners.delete(listener);
}

/**
 * Whether demo fixtures may stand in for unreachable endpoints.
 *
 * Off by default. Fixtures are a demo aid, and a build that silently shows 120
 * invented devices to an operator deciding whether their mesh is healthy is worse
 * than one that shows an error. Enable with VITE_ALLOW_MOCK_DATA=true.
 */
export function mockDataAllowed() {
  try {
    return import.meta.env?.VITE_ALLOW_MOCK_DATA === 'true';
  } catch (err) {
    return false;
  }
}

/**
 * Resolve a list endpoint.
 *
 * An empty array from a request that succeeded is a real answer and is returned as
 * such: "no nodes are registered" is information the operator needs, and replacing
 * it with fixtures destroys it. Fixtures are used only when the request genuinely
 * failed, and only when the build allows them -- and the substitution is recorded so
 * the UI can say so.
 */
export function resolveList(endpoint, liveValue, mockValue) {
  if (Array.isArray(liveValue)) {
    return liveValue;
  }

  if (mockDataAllowed()) {
    markMocked(endpoint);
    return mockValue;
  }

  return [];
}

/** Resolve a single-object endpoint, with the same rules as resolveList. */
export function resolveOne(endpoint, liveValue, mockValue) {
  if (liveValue !== null && liveValue !== undefined) {
    return liveValue;
  }

  if (mockDataAllowed()) {
    markMocked(endpoint);
    return mockValue;
  }

  return null;
}
