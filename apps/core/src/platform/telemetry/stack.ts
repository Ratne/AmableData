import type { StackFrame } from '@amable/core/platform';
import { scrubFile } from './scrub';

const MAX_FRAMES = 30;

// `    at fn (file:line:col)` / `    at async fn (file:line:col)` / `    at file:line:col`
const WITH_FN = /^\s*at\s+(?:async\s+)?(.+?)\s+\((.+?)(?::(\d+))?(?::(\d+))?\)\s*$/;
const BARE = /^\s*at\s+(?:async\s+)?(.+?)(?::(\d+))?(?::(\d+))?\s*$/;

function toInt(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

/** Parses a V8 `error.stack` into frames (innermost first), files scrubbed. */
export function parseV8Stack(stack: string | undefined): StackFrame[] {
  if (stack === undefined || stack === '') return [];
  const frames: StackFrame[] = [];
  for (const line of stack.split('\n')) {
    if (frames.length >= MAX_FRAMES) break;
    if (!/^\s*at\s/.test(line)) continue;
    const named = WITH_FN.exec(line);
    if (named !== null) {
      frames.push({
        fn: named[1] ?? null,
        file: named[2] === undefined ? null : scrubFile(named[2]),
        line: toInt(named[3]),
        column: toInt(named[4]),
      });
      continue;
    }
    const bare = BARE.exec(line);
    if (bare !== null) {
      frames.push({
        fn: null,
        file: bare[1] === undefined ? null : scrubFile(bare[1]),
        line: toInt(bare[2]),
        column: toInt(bare[3]),
      });
    }
  }
  return frames;
}
