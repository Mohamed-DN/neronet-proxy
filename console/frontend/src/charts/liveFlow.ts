/*
 * Real traffic, drawn as motion. Nothing here is invented: a line moves only when
 * the per-device byte counters the console already has (rx_bytes and tx_bytes of
 * the device list) grew between two refreshes. No earlier refresh, a counter that
 * is missing or went backwards, or a gap too long to mean "recently": unknown,
 * and unknown does not move.
 */

export interface CounterSample {
  /** When the counters were read, in ms. */
  at: number;
  /** Cumulative rx + tx bytes by device id; a device with no readable counter is absent. */
  bytes: Map<string, number>;
}

/** Traffic counts as recent for this long after the refresh that saw it. */
export const RECENT_MS = 60_000;
/** Two refreshes further apart than this say nothing about "now". */
export const MAX_GAP_MS = 120_000;

const toBytes = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Reads the counters of a device list. A device with neither counter is not measured. */
export function sampleCounters(
  nodes: ReadonlyArray<{ id: string; rx_bytes?: unknown; tx_bytes?: unknown }>,
  at: number
): CounterSample {
  const bytes = new Map<string, number>();
  for (const node of nodes) {
    const rx = toBytes(node.rx_bytes);
    const tx = toBytes(node.tx_bytes);
    if (rx === null && tx === null) continue;
    bytes.set(node.id, (rx ?? 0) + (tx ?? 0));
  }
  return { at, bytes };
}

/**
 * Bytes per second carried by each line between two samples, or null when the line
 * has no device measured in both. 0 means measured and quiet.
 */
export function lineRates(
  previous: CounterSample | null,
  current: CounterSample,
  lineOf: ReadonlyMap<string, string>
): Map<string, number | null> {
  const rates = new Map<string, number | null>();
  for (const key of new Set(lineOf.values())) rates.set(key, null);
  if (previous === null) return rates;
  const gap = current.at - previous.at;
  if (gap <= 0 || gap > MAX_GAP_MS) return rates;
  const sums = new Map<string, number>();
  for (const [id, now] of current.bytes) {
    const before = previous.bytes.get(id);
    const key = lineOf.get(id);
    // A counter that went backwards was reset (a restart): that interval is unknown for the device.
    if (before === undefined || key === undefined || now < before) continue;
    sums.set(key, (sums.get(key) ?? 0) + (now - before));
  }
  for (const [key, delta] of sums) rates.set(key, delta / (gap / 1000));
  return rates;
}

export interface FlowParams {
  /** Pulses visible on the line at once, 1 to 3. */
  pulses: number;
  /** Time for a pulse to cross the line, in ms: never faster than 1600. */
  durationMs: number;
}

const LOW_BPS = 1_000;
const HIGH_BPS = 10_000_000;
export const MAX_PULSES = 3;
const SLOWEST_MS = 4200;
const FASTEST_MS = 1600;

/** Throughput to motion, on a log scale clamped from 1 kB/s to 10 MB/s. Null, zero or not a number: no motion. */
export function flowParams(rate: number | null | undefined): FlowParams | null {
  if (rate === null || rate === undefined || !Number.isFinite(rate) || rate <= 0) return null;
  const span = Math.log10(HIGH_BPS) - Math.log10(LOW_BPS);
  const t = Math.max(0, Math.min(1, (Math.log10(rate) - Math.log10(LOW_BPS)) / span));
  return {
    pulses: Math.min(MAX_PULSES, 1 + Math.round(t * (MAX_PULSES - 1))),
    durationMs: Math.round(SLOWEST_MS - t * (SLOWEST_MS - FASTEST_MS))
  };
}

/** The motion of every line that has some, capped so a big map never animates more than `cap` pulses. */
export function flowForLines(rates: ReadonlyMap<string, number | null>, cap = 18): Map<string, FlowParams> {
  const out = new Map<string, FlowParams>();
  let used = 0;
  for (const [key, rate] of rates) {
    const params = flowParams(rate);
    if (!params) continue;
    const pulses = Math.min(params.pulses, cap - used);
    if (pulses <= 0) break;
    used += pulses;
    out.set(key, { ...params, pulses });
  }
  return out;
}
