import { createD1MigrationStore, installationMigrations, runMigrations } from '@amable/db';
import { formatLicenseKey, type ErrorBatchRequest } from '@amable/core/platform';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../src/env';
import { handleError } from '../../../src/middleware/error-handler';
import type { AppEnv } from '../../../src/middleware/context';
import { overrideControlPlaneFetch } from '../../../src/platform/client';
import {
  EDGE_ERROR_REPORT_OP,
  EDGE_GATEWAY_PATH,
  EDGE_GATEWAY_SIGNATURE_HEADER,
  EDGE_INSTALLATION_TENANT,
} from '@amable/api-types';
import { signWebhook } from '@amable/auth/security';
import { handleEdgeGateway } from '../../../src/public/gateway';
import {
  AlarmStepError,
  addBreadcrumb,
  flushErrorOutbox,
  moduleFromRoute,
  pendingErrorCount,
  reportAlarmFailure,
  reportError,
  withAlarmReporting,
  withErrorReporting,
} from '../../../src/platform/telemetry';
import { clearBreadcrumbs } from '../../../src/platform/telemetry/breadcrumbs';
import { resetReportingKnobsCache } from '../../../src/platform/telemetry/config';
import { backoffMs, overrideErrorSinkFetch } from '../../../src/platform/telemetry/outbox';
import { resetOpportunisticFlush } from '../../../src/platform/telemetry/reporter';
import { repeatFactor, resetSampler, SAMPLE_KEEP_FIRST } from '../../../src/platform/telemetry/sampling';
import { scrubMessage, scrubText } from '../../../src/platform/telemetry/scrub';
import { parseV8Stack } from '../../../src/platform/telemetry/stack';
import { createShimD1 } from '../../helpers/d1-shim';

const START = Date.UTC(2026, 9, 15, 12, 0, 0);
const INSTALLATION_ID = '01JA0000000000000000000000';
const LICENSE = formatLicenseKey(INSTALLATION_ID, 'x'.repeat(40));

async function makeEnv(vars: Partial<Env> = {}): Promise<Env> {
  const { db } = createShimD1();
  await runMigrations(createD1MigrationStore(db, { metaTable: 'installation_meta' }), installationMigrations);
  return { DB: db, ENVIRONMENT: 'test', APP_VERSION: '2026.10.1', ...vars } as unknown as Env;
}

async function outboxRows(env: Env) {
  return (
    await env.DB.prepare(`SELECT id, payload, attempts, next_attempt_at FROM platform_error_outbox ORDER BY created_at, id`).all<{
      id: string;
      payload: string;
      attempts: number;
      next_attempt_at: number;
    }>()
  ).results;
}

function boom(message = 'kaboom'): Error {
  return new TypeError(message);
}

interface Recorded {
  url: string;
  auth: string | null;
  body: ErrorBatchRequest;
}

function recorder(statuses: number[]) {
  const calls: Recorded[] = [];
  const fetchFn = (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get('authorization'), body: JSON.parse(String(init?.body)) as ErrorBatchRequest });
    const status = statuses.shift() ?? 200;
    return Promise.resolve(new Response(JSON.stringify(status < 300 ? { accepted: 1, duplicates: 0 } : { error: 'x' }), { status }));
  };
  return { calls, fetchFn };
}

beforeEach(() => {
  resetSampler();
  resetReportingKnobsCache();
  resetOpportunisticFlush();
  clearBreadcrumbs();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  overrideControlPlaneFetch(null);
  overrideErrorSinkFetch(null);
  vi.restoreAllMocks();
});

describe('scrubbing', () => {
  it('removes emails, tokens, keys, long numbers, query strings and quoted strings', () => {
    const message = scrubMessage(
      `User "mario.rossi@example.com" failed with Bearer abc.def amb_lic_01JA0000000000000000000000_secretsecret ` +
        `hash 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b phone 3471234567 url /x?email=a%40b.it&t=1 from 10.0.0.12 'Mario'`,
    );
    expect(message).not.toMatch(/mario|example\.com|abc\.def|secretsecret|9f86d0818|3471234567|a%40b|10\.0\.0\.12|Mario/);
    expect(message).toContain('[str]');
    expect(message).toContain('Bearer [token]');
    expect(scrubText('contact anna@example.org now')).toBe('contact [email] now');
    expect(scrubText('from 2001:db8:85a3::8a2e:370:7334 and ::ffff:10.1.2.3 at 09:15:00')).toBe('from [ip] and [ip] at 09:15:00');
    expect(scrubText('ok plain text with someVeryLongIdentifierName')).toBe('ok plain text with someVeryLongIdentifierName');
  });

  it('parses V8 stacks and scrubs frame files', () => {
    const frames = parseV8Stack(
      'TypeError: x\n    at handler (https://crm.example.com/src/crm/ops.ts?v=abc:12:5)\n    at async Engine.alarm (worker.js:40:3)\n    at file:///w/index.js:1:2',
    );
    expect(frames).toEqual([
      { fn: 'handler', file: '/src/crm/ops.ts', line: 12, column: 5 },
      { fn: 'Engine.alarm', file: 'worker.js', line: 40, column: 3 },
      { fn: null, file: 'file:///w/index.js', line: 1, column: 2 },
    ]);
  });

  it('derives the module from the route pattern', () => {
    expect(moduleFromRoute('/api/v2/t/:slug/contacts/:id')).toBe('contacts');
    expect(moduleFromRoute('/api/auth/login')).toBe('auth');
    expect(moduleFromRoute(null)).toBeNull();
  });
});

describe('local sink', () => {
  it('never writes the outbox (default and control_plane without license)', async () => {
    for (const vars of [{}, { ERROR_REPORTING: 'local' }, { ERROR_REPORTING: 'control_plane' }]) {
      const env = await makeEnv(vars);
      await reportError(env, boom(), { source: 'api', route: '/api/x' }, { nowMs: START });
      expect(await outboxRows(env)).toHaveLength(0);
      await flushErrorOutbox(env, START);
    }
    expect(console.error).toHaveBeenCalled();
  });
});

describe('control plane sink', () => {
  it('buffers, then delivers in batches with retry and exponential backoff', async () => {
    const env = await makeEnv({ ERROR_REPORTING: 'control_plane', LICENSE_KEY: LICENSE, CONTROL_PLANE_URL: 'https://cp.test' });
    addBreadcrumb('http', 'GET /api/v2/t/:slug/contacts for anna@example.org', START - 10);
    await reportError(env, boom('first contact 01JA0000000000000000000099'), { source: 'api', route: '/api/v2/t/:slug/contacts' }, { nowMs: START });
    await reportError(env, new RangeError('second'), { source: 'queue', module: 'email' }, { nowMs: START });
    expect(await pendingErrorCount(env)).toBe(2);

    const { calls, fetchFn } = recorder([503, 200]);
    overrideControlPlaneFetch(fetchFn);

    await flushErrorOutbox(env, START);
    expect(calls).toHaveLength(1);
    let rows = await outboxRows(env);
    expect(rows.map((r) => r.attempts)).toEqual([1, 1]);
    expect(rows[0]?.next_attempt_at).toBe(START + backoffMs(1));

    await flushErrorOutbox(env, START + backoffMs(1) - 1);
    expect(calls).toHaveLength(1);

    await flushErrorOutbox(env, START + backoffMs(1));
    expect(calls).toHaveLength(2);
    expect(await outboxRows(env)).toHaveLength(0);

    const sent = calls[1];
    expect(sent?.url).toBe('https://cp.test/v1/installation/errors');
    expect(sent?.auth).toBe(`Bearer ${LICENSE}`);
    expect(sent?.body.events).toHaveLength(2);
    const first = sent?.body.events[0];
    expect(first?.release).toBe('2026.10.1');
    expect(first?.route).toBe('/api/v2/t/:slug/contacts');
    expect(first?.errorType).toBe('TypeError');
    expect(first?.frames.length).toBeGreaterThan(0);
    expect(JSON.stringify(sent?.body)).not.toMatch(/anna@example\.org|01JA0000000000000000000099/);
    expect(first?.breadcrumbs[0]?.message).toContain('[email]');

    rows = await outboxRows(env);
    expect(rows).toHaveLength(0);
    expect(backoffMs(2)).toBe(2 * backoffMs(1));
  });

  it('honors maxBatch pushed by the control plane and drops rejected batches', async () => {
    const env = await makeEnv({ ERROR_REPORTING: 'control_plane', LICENSE_KEY: LICENSE });
    await env.DB.prepare(`INSERT INTO installation_meta (key, value) VALUES ('platform:reporting', ?)`)
      .bind(JSON.stringify({ sampleRate: 1, maxBatch: 2 }))
      .run();
    for (let i = 0; i < 5; i += 1) {
      await reportError(env, new Error(`distinct ${String(i)}`), { source: 'cron', module: `m${String(i)}` }, { nowMs: START + i });
    }
    const { calls, fetchFn } = recorder([200, 422, 200]);
    overrideControlPlaneFetch(fetchFn);
    await flushErrorOutbox(env, START + 10);
    expect(calls.map((c) => c.body.events.length)).toEqual([2, 2, 1]);
    expect(await outboxRows(env)).toHaveLength(0);
  });

  it('posts to a custom https endpoint', async () => {
    const env = await makeEnv({ ERROR_REPORTING: 'https://errors.example.net/ingest' });
    await reportError(env, boom(), { source: 'durable_object', module: 'automation' }, { nowMs: START });
    const { calls, fetchFn } = recorder([200]);
    overrideErrorSinkFetch(fetchFn);
    await flushErrorOutbox(env, START);
    expect(calls[0]?.url).toBe('https://errors.example.net/ingest');
    expect(calls[0]?.auth).toBeNull();
    expect(await outboxRows(env)).toHaveLength(0);
  });
});

describe('sampling', () => {
  it('keeps the first N per window, then one in K with sampleWeight K', async () => {
    const env = await makeEnv({ ERROR_REPORTING: 'control_plane', LICENSE_KEY: LICENSE, ERROR_SAMPLE_RATE: '0.5' });
    const k = repeatFactor(0.5);
    expect(k).toBe(20);
    const error = boom('same');
    for (let i = 0; i < SAMPLE_KEEP_FIRST + 2 * k; i += 1) {
      await reportError(env, error, { source: 'api' }, { nowMs: START + i });
    }
    const weights = (await outboxRows(env)).map((r) => (JSON.parse(r.payload) as { sampleWeight: number }).sampleWeight);
    expect(weights).toEqual([...Array<number>(SAMPLE_KEEP_FIRST).fill(1), k, k]);

    // a new window starts over
    await reportError(env, error, { source: 'api' }, { nowMs: START + 61_000 });
    const last = (await outboxRows(env)).at(-1);
    expect((JSON.parse(last?.payload ?? '{}') as { sampleWeight: number }).sampleWeight).toBe(1);
  });
});

describe('integration', () => {
  it('the API error handler reports the route pattern and keeps the opaque 500', async () => {
    const env = await makeEnv({ ERROR_REPORTING: 'control_plane', LICENSE_KEY: LICENSE });
    const app = new Hono<AppEnv>();
    app.onError(handleError);
    app.get('/api/v2/t/:slug/deals/:id', () => {
      throw new Error('deal for luigi@example.com missing');
    });
    const res = await app.request('http://localhost/api/v2/t/acme/deals/123456789', {}, env);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal_error' });
    await vi.waitFor(async () => expect(await outboxRows(env)).toHaveLength(1));
    const event = JSON.parse((await outboxRows(env))[0]?.payload ?? '{}') as Record<string, unknown>;
    expect(event.route).toBe('/api/v2/t/:slug/deals/:id');
    expect(event.module).toBe('deals');
    expect(event.source).toBe('api');
    expect(JSON.stringify(event)).not.toMatch(/luigi|acme|123456789/);
  });

  it('withErrorReporting reports and rethrows', async () => {
    const env = await makeEnv({ ERROR_REPORTING: 'control_plane', LICENSE_KEY: LICENSE });
    await expect(
      withErrorReporting(env, 'queue', 'email', () => Promise.reject(new Error('send failed'))),
    ).rejects.toThrow('send failed');
    const event = JSON.parse((await outboxRows(env))[0]?.payload ?? '{}') as Record<string, unknown>;
    expect(event.source).toBe('queue');
    expect(event.module).toBe('email');
    await expect(withErrorReporting(env, 'cron', 'x', () => Promise.resolve(7))).resolves.toBe(7);
  });
});

describe('Durable Object alarms and edge errors', () => {
  const state = () => {
    const pending: Promise<unknown>[] = [];
    return { pending, waitUntil: (p: Promise<unknown>) => void pending.push(p) };
  };

  it('alarm failures are reported (route `alarm`) and rethrown; handled failures too', async () => {
    const env = await makeEnv({ ERROR_REPORTING: 'control_plane', LICENSE_KEY: LICENSE });
    const ctx = state();
    await expect(withAlarmReporting(env, 'automation', ctx, () => Promise.reject(boom('alarm broke')))).rejects.toThrow('alarm broke');
    await reportAlarmFailure(env, 'email', ctx, new AlarmStepError('broadcasts.tick internal_error: x'));
    const events = (await outboxRows(env)).map((r) => JSON.parse(r.payload) as Record<string, unknown>);
    expect(events.map((e) => [e.source, e.module, e.route, e.errorType])).toEqual([
      ['durable_object', 'automation', 'alarm', 'TypeError'],
      ['durable_object', 'email', 'alarm', 'AlarmStepError'],
    ]);
    await expect(withAlarmReporting(env, 'tenant-db', ctx, () => Promise.resolve(1))).resolves.toBe(1);
  });

  it('self-hosted (local sink): alarm errors only reach the logs', async () => {
    const env = await makeEnv();
    await expect(withAlarmReporting(env, 'tenant-db', state(), () => Promise.reject(boom()))).rejects.toThrow();
    expect(await outboxRows(env)).toHaveLength(0);
    expect(vi.mocked(console.error).mock.calls.some((args) => String(args[0]).includes('[error-monitor] durable_object alarm TypeError'))).toBe(true);
  });

  async function edgeReport(env: Env, input: unknown) {
    const body = JSON.stringify({
      nonce: `n${Math.random().toString(36).slice(2)}aaaaaaaaaaaaaaaa`.slice(0, 32),
      op: EDGE_ERROR_REPORT_OP,
      tenant: EDGE_INSTALLATION_TENANT,
      client: { ip: null, userAgent: null, country: null, visitorId: null, referer: null, acceptLanguage: null },
      input,
    });
    const request = new Request(`https://core.internal${EDGE_GATEWAY_PATH}`, {
      method: 'POST',
      headers: { [EDGE_GATEWAY_SIGNATURE_HEADER]: await signWebhook('edge-secret', body) },
      body,
    });
    return handleEdgeGateway(request, env, { waitUntil: () => undefined } as unknown as ExecutionContext);
  }

  const report = {
    source: 'edge',
    module: 'edge',
    route: '/f/:slug',
    errorType: 'RangeError',
    message: 'bad offset for anna@example.org from 2001:db8::1',
    stack: 'RangeError: bad\n    at render (file:///worker/forms.js:10:5)',
  };

  it('edge reports go through the installation reporter: sink selection and scrubbing', async () => {
    const env = await makeEnv({ ERROR_REPORTING: 'control_plane', LICENSE_KEY: LICENSE, EDGE_GATEWAY_SECRET: 'edge-secret' });
    const res = await edgeReport(env, report);
    expect(res.status).toBe(200);
    const [event] = (await outboxRows(env)).map((r) => JSON.parse(r.payload) as Record<string, unknown>);
    expect(event).toMatchObject({ source: 'edge', module: 'edge', route: '/f/:slug', errorType: 'RangeError', release: '2026.10.1' });
    expect(String(event?.message)).toBe('bad offset for [email] from [ip]');
    expect((await edgeReport(env, { ...report, source: 'api' })).status).toBe(400);

    const local = await makeEnv({ EDGE_GATEWAY_SECRET: 'edge-secret' });
    expect((await edgeReport(local, report)).status).toBe(200);
    expect(await outboxRows(local)).toHaveLength(0);
  });
});
