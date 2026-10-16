/**
 * Client-side sampling of repeated errors, per local fingerprint and per
 * isolate: inside a window the first `keepFirst` events are always kept, then
 * one in `k` is kept and carries `sampleWeight = k`, so the control plane can
 * still estimate the real count. `k = ceil(BASE_K / sampleRate)`.
 */

export const SAMPLE_WINDOW_MS = 60_000;
export const SAMPLE_KEEP_FIRST = 10;
const BASE_K = 10;
const MAX_KEYS = 500;

interface WindowState {
  start: number;
  seen: number;
}

const windows = new Map<string, WindowState>();

export function repeatFactor(sampleRate: number): number {
  const rate = Number.isFinite(sampleRate) ? Math.min(1, Math.max(0.01, sampleRate)) : 1;
  return Math.ceil(BASE_K / rate);
}

/** Returns the weight of the event to keep, or null when it is dropped. */
export function sampleEvent(key: string, nowMs: number, sampleRate: number): number | null {
  let state = windows.get(key);
  if (state === undefined || nowMs - state.start >= SAMPLE_WINDOW_MS) {
    if (state === undefined && windows.size >= MAX_KEYS) windows.clear();
    state = { start: nowMs, seen: 0 };
    windows.set(key, state);
  }
  state.seen += 1;
  if (state.seen <= SAMPLE_KEEP_FIRST) return 1;
  const k = repeatFactor(sampleRate);
  return (state.seen - SAMPLE_KEEP_FIRST) % k === 0 ? k : null;
}

/** Test hook. */
export function resetSampler(): void {
  windows.clear();
}
