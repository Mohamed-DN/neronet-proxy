/**
 * How often a live view reads again when no event arrives (ADR 0042).
 *
 * Events on the live channel are the primary way a view learns that something changed;
 * this is the fallback for a missed event and for values that age without one (a device
 * that stops answering sends nothing). It runs only while the tab is visible: a hidden
 * tab reads again when it is shown, through the window focus refetch.
 */
export const LIVE_POLL_MS = 10_000;

export function visibleInterval(ms: number = LIVE_POLL_MS): number | false {
  if (typeof document === 'undefined') return ms;
  return document.visibilityState === 'visible' ? ms : false;
}
