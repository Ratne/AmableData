import type { ErrorEvent, ErrorSource, StackFrame } from '@amable/core/platform';
import { ulid } from 'ulid';
import type { Env } from '../../env';
import { snapshotBreadcrumbs } from './breadcrumbs';
import { reportingKnobs, resolveErrorSink } from './config';
import { enqueueErrorEvent, flushErrorOutbox } from './outbox';
import { sampleEvent } from './sampling';
import { scrubMessage } from './scrub';
import { parseV8Stack } from './stack';

export interface ErrorMeta {
  readonly source: ErrorSource;
  /** Module, e.g. `email`, `crm`, `automation`. */
  readonly module?: string | null;
  /** Route pattern (`/api/v2/t/:slug/contacts/:id`), never the concrete URL. */
  readonly route?: string | null;
}

export interface ReportOptions {
  /** Runs the opportunistic outbox flush after the response (ExecutionContext / DO state). */
  readonly waitUntil?: (promise: Promise<unknown>) => void;
  readonly nowMs?: number;
}

const OPPORTUNISTIC_FLUSH_EVERY_MS = 10_000;
let lastOpportunisticFlush = 0;

function errorType(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name !== '' && error.name !== 'Error' ? error.name : error.constructor.name;
    return (name === '' ? 'Error' : name).slice(0, 100);
  }
  return error === null ? 'null' : typeof error;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return scrubMessage(error.message);
  if (typeof error === 'string') return scrubMessage(error);
  return 'non-error value thrown';
}

/** Builds a scrubbed event: no request data, no personal data, route pattern only. */
export function buildErrorEvent(env: Env, error: unknown, meta: ErrorMeta, nowMs: number): ErrorEvent {
  return {
    eventId: ulid(nowMs),
    occurredAt: new Date(nowMs).toISOString(),
    source: meta.source,
    module: meta.module ?? null,
    route: meta.route ?? null,
    errorType: errorType(error),
    message: errorMessage(error),
    frames: error instanceof Error ? parseV8Stack(error.stack) : [],
    breadcrumbs: snapshotBreadcrumbs(),
    release: env.APP_VERSION?.trim() || 'dev',
    sampleWeight: 1,
  };
}

function frameKey(frame: StackFrame): string {
  return `${frame.fn ?? '?'}@${frame.file ?? '?'}`;
}

/** Local grouping key for sampling (line numbers ignored). */
export function localFingerprint(event: Pick<ErrorEvent, 'errorType' | 'frames' | 'message'>): string {
  if (event.frames.length > 0) return `${event.errorType}|${event.frames.slice(0, 3).map(frameKey).join('|')}`;
  return `${event.errorType}|${event.message.replace(/\d+/g, '0').slice(0, 200)}`;
}

/**
 * Reports one error. Never throws: a broken reporter must not break the
 * request or the job that failed. Local sink → console; other sinks → D1 outbox,
 * delivered by `flushErrorOutbox` (cron + opportunistic).
 */
export async function reportError(env: Env, error: unknown, meta: ErrorMeta, options: ReportOptions = {}): Promise<void> {
  try {
    const nowMs = options.nowMs ?? Date.now();
    const sink = resolveErrorSink(env);
    const knobs = sink.kind === 'local' ? { sampleRate: 1 } : await reportingKnobs(env, nowMs);
    const event = buildErrorEvent(env, error, meta, nowMs);
    const fingerprint = localFingerprint(event);
    const weight = sampleEvent(fingerprint, nowMs, knobs.sampleRate);
    if (weight === null) return;
    const sampled: ErrorEvent = { ...event, sampleWeight: weight };
    if (sink.kind === 'local') {
      const top = sampled.frames[0];
      console.error(
        `[error-monitor] ${sampled.source}${sampled.route === null ? '' : ` ${sampled.route}`} ${sampled.errorType}: ${sampled.message}` +
          (top === undefined ? '' : ` at ${frameKey(top)}`),
      );
      return;
    }
    await enqueueErrorEvent(env, sampled, fingerprint, nowMs);
    if (options.waitUntil !== undefined && nowMs - lastOpportunisticFlush >= OPPORTUNISTIC_FLUSH_EVERY_MS) {
      lastOpportunisticFlush = nowMs;
      options.waitUntil(flushErrorOutbox(env, nowMs).catch(() => undefined));
    }
  } catch (failure) {
    console.error('[error-monitor] reporter failed', failure instanceof Error ? failure.name : typeof failure);
  }
}

/**
 * Runs `fn`, reports what it throws and rethrows (queue retries, alarm retries
 * and cron failure semantics stay unchanged).
 */
export async function withErrorReporting<R>(
  env: Env,
  source: ErrorSource,
  module: string,
  fn: () => Promise<R>,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<R> {
  try {
    return await fn();
  } catch (error) {
    await reportError(env, error, { source, module, route: null }, { waitUntil });
    throw error;
  }
}

/**
 * Durable Object `alarm()`: reports what the handler throws (route `alarm`)
 * and rethrows, so the runtime keeps its alarm retry semantics.
 */
export async function withAlarmReporting<R>(
  env: Env,
  module: string,
  state: Pick<DurableObjectState, 'waitUntil'>,
  fn: () => Promise<R>,
): Promise<R> {
  try {
    return await fn();
  } catch (error) {
    await reportError(env, error, { source: 'durable_object', module, route: 'alarm' }, { waitUntil: (p) => state.waitUntil(p) });
    throw error;
  }
}

/** A failure an alarm handles itself (logged, not thrown) still reaches the reporter. */
export class AlarmStepError extends Error {
  override readonly name = 'AlarmStepError';
}

export function reportAlarmFailure(env: Env, module: string, state: Pick<DurableObjectState, 'waitUntil'>, error: unknown): Promise<void> {
  return reportError(env, error, { source: 'durable_object', module, route: 'alarm' }, { waitUntil: (p) => state.waitUntil(p) });
}

/** Test hook. */
export function resetOpportunisticFlush(): void {
  lastOpportunisticFlush = 0;
}
