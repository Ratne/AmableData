import { createSandboxedLiquid } from '@amable/auth/security';
import type { Liquid } from 'liquidjs';

/**
 * Static checks on user Liquid with the same sandboxed configuration used to
 * send (so a template that validates here parses at send time): syntax errors
 * with their position and the context variables a template reads.
 */

export interface LiquidIssue {
  readonly message: string;
  /** 1-based; null when the engine reports no position. */
  readonly line: number | null;
  readonly column: number | null;
}

let shared: Liquid | null = null;
function engine(): Liquid {
  shared ??= createSandboxedLiquid({ escapeHtml: false });
  return shared;
}

interface PositionedToken {
  getPosition(): [number, number];
}

function hasToken(error: object): error is { token: PositionedToken } {
  const token = (error as { token?: unknown }).token;
  return (
    typeof token === 'object' &&
    token !== null &&
    typeof (token as { getPosition?: unknown }).getPosition === 'function'
  );
}

/** Message and position of a liquidjs error (parse or render). */
export function liquidIssue(error: unknown): LiquidIssue {
  if (typeof error !== 'object' || error === null) {
    return { message: String(error), line: null, column: null };
  }
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.replace(/,\s*line:\d+,\s*col:\d+\s*$/, '').trim();
  if (hasToken(error)) {
    try {
      const [line, column] = error.token.getPosition();
      return { message, line, column };
    } catch {
      // fall through: position unavailable
    }
  }
  const match = /line:(\d+),\s*col:(\d+)/.exec(raw);
  return {
    message,
    line: match?.[1] === undefined ? null : Number(match[1]),
    column: match?.[2] === undefined ? null : Number(match[2]),
  };
}

export interface LiquidValidation {
  readonly ok: boolean;
  readonly errors: readonly LiquidIssue[];
}

/** Parses with the send-time configuration (strict filters, size limit). */
export function validateLiquid(source: string): LiquidValidation {
  try {
    engine().parse(source);
    return { ok: true, errors: [] };
  } catch (error) {
    return { ok: false, errors: [liquidIssue(error)] };
  }
}

type Segment = string | number | Segment[];

/**
 * Dotted paths of the global variables a template reads (loop variables and
 * `assign`s excluded), e.g. `contact.first_name`, `contact.custom.vip`.
 * Throws the liquidjs error when the template does not parse.
 */
export function liquidVariablePaths(source: string): string[] {
  const segments = engine().globalVariableSegmentsSync(source) as Segment[][];
  const paths = new Set<string>();
  for (const segment of segments) {
    const parts: string[] = [];
    for (const part of segment) {
      if (Array.isArray(part)) break;
      parts.push(String(part));
    }
    if (parts.length > 0) paths.add(parts.join('.'));
  }
  return [...paths];
}

/** Names of the filters the sandbox accepts (strict filters: anything else is an error). */
export function liquidFilterNames(): string[] {
  return Object.keys(engine().filters).sort();
}
