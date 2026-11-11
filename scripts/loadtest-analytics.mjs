#!/usr/bin/env node
/**
 * Ingest load test of the edge tracking endpoint (one site, sustained rate):
 *
 *   node scripts/loadtest-analytics.mjs --site st_xxx --origin https://www.example.com
 *     [--url http://localhost:8788] [--rate 1000] [--duration 60] [--visitors 5000]
 *     [--max-error-rate 0.001] [--max-p99-ms 500]
 *
 * Sends tracker pageviews/goals (`POST /e`, the tracker wire format) with the
 * site's own origin, spread over `--visitors` visitors, at `--rate` events per
 * second for `--duration` seconds. Prints throughput, status counts and latency
 * percentiles; exits 1 when the error rate or the p99 latency exceed the gates.
 *
 * The production gate is 1000 ev/s on a single site against staging; locally
 * (wrangler dev, one process) it only validates the script and gives a floor.
 * The script does not read back the counts: compare the site overview with the
 * `accepted` figure once the queue drained (WAL objects under events/<site>/).
 */
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const url = opt('url', process.env.SEED_EDGE_URL ?? 'http://localhost:8788').replace(/\/+$/, '');
const site = opt('site');
const origin = opt('origin');
if (!site || !origin) {
  console.error(
    'usage: loadtest-analytics.mjs --site <siteId> --origin <https://site.origin> [--rate N] [--duration S]',
  );
  process.exit(2);
}
const rate = Number(opt('rate', '1000'));
const duration = Number(opt('duration', '60'));
const visitors = Number(opt('visitors', '5000'));
const maxErrorRate = Number(opt('max-error-rate', '0.001'));
const maxP99 = Number(opt('max-p99-ms', '500'));
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const PATHS = ['/', '/pricing', '/features', '/blog/launch', '/contact', '/checkout'];

const hex = (n) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
const pool = Array.from({ length: visitors }, () => ({
  vid: crypto.randomUUID(),
  sid: `s${hex(16)}`,
  fs: Date.now(),
  sn: 1,
}));

function payload(i) {
  const v = pool[i % pool.length];
  const path = PATHS[i % PATHS.length];
  const base = {
    site,
    id: crypto.randomUUID(),
    at: Date.now(),
    url: `${origin}${path}?utm_source=load&utm_medium=cpc&utm_campaign=lt`,
    ref: 'https://www.google.com/',
    vw: 1280,
    vh: 800,
    sw: 1440,
    sh: 900,
    lang: 'it-IT',
    tz: 'Europe/Rome',
    vid: v.vid,
    sid: v.sid,
    fs: v.fs,
    sn: v.sn,
    src: { utm_source: 'load', utm_medium: 'cpc', utm_campaign: 'lt' },
  };
  return i % 10 === 9 ? { ...base, type: 'goal', name: 'signup' } : { ...base, type: 'pageview' };
}

const latencies = [];
const statuses = new Map();
let inflight = 0;
let maxInflight = 0;
let sent = 0;

async function fire(i) {
  inflight += 1;
  maxInflight = Math.max(maxInflight, inflight);
  const started = performance.now();
  let status = 'network_error';
  try {
    const res = await fetch(`${url}/e`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain;charset=UTF-8',
        origin,
        'user-agent': UA,
        'cf-connecting-ip': `198.51.100.${(i % 250) + 1}`,
      },
      body: JSON.stringify(payload(i)),
    });
    await res.arrayBuffer();
    status = String(res.status);
  } catch {
    // counted as network_error
  }
  latencies.push(performance.now() - started);
  statuses.set(status, (statuses.get(status) ?? 0) + 1);
  inflight -= 1;
}

const TICK_MS = 50;
const perTick = rate / (1000 / TICK_MS);
const startedAt = performance.now();
const pending = new Set();
let budget = 0;
console.log(`load test: ${rate} ev/s for ${duration}s → ${url}/e (site ${site})`);
while (performance.now() - startedAt < duration * 1000) {
  budget += perTick;
  while (budget >= 1) {
    budget -= 1;
    const p = fire(sent);
    sent += 1;
    pending.add(p);
    void p.finally(() => pending.delete(p));
  }
  await new Promise((r) => setTimeout(r, TICK_MS));
}
await Promise.all(pending);
const elapsed = (performance.now() - startedAt) / 1000;

latencies.sort((a, b) => a - b);
const pct = (p) =>
  latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))] ?? 0;
const accepted = [...statuses].filter(([s]) => s.startsWith('2')).reduce((n, [, c]) => n + c, 0);
const errors = sent - accepted;
const errorRate = sent === 0 ? 0 : errors / sent;
const p99 = pct(99);
console.log(
  JSON.stringify(
    {
      sent,
      accepted,
      errors,
      error_rate: Number(errorRate.toFixed(5)),
      achieved_rate: Math.round(sent / elapsed),
      statuses: Object.fromEntries(statuses),
      latency_ms: {
        p50: Math.round(pct(50)),
        p95: Math.round(pct(95)),
        p99: Math.round(p99),
        max: Math.round(pct(100)),
      },
      max_inflight: maxInflight,
    },
    null,
    2,
  ),
);
const failed = errorRate > maxErrorRate || p99 > maxP99;
if (failed) console.error(`FAILED gates: error rate ≤ ${maxErrorRate}, p99 ≤ ${maxP99} ms`);
process.exit(failed ? 1 : 0);
