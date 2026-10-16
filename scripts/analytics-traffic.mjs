#!/usr/bin/env node
/**
 * Local demo traffic for web analytics (dev only, after `pnpm seed`):
 *
 *   node scripts/analytics-traffic.mjs [--days 30] [--per-day 220] [--live 120]
 *
 * Calls the dev routes of apps/core (`ENVIRONMENT=dev`): creates the demo site if
 * missing, generates sessions over the period (channels, campaigns, geo, devices,
 * goals, bots), identifies seeded CRM contacts before their real payments so CRM
 * revenue gets attributed, runs the CRM sync, demo funnels / segments / alert /
 * share link / integrations and trains the prediction model. `--live N` then keeps
 * a few visitors online for N seconds (realtime view and globe).
 */
const BASE_URL = process.env.SEED_BASE_URL ?? 'http://localhost:8787';
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const tenant = opt('tenant', 'demo');

async function post(path) {
  const res = await fetch(`${BASE_URL}${path}`, { method: 'POST' });
  const body = await res.json().catch(() => ({}));
  if (res.status === 404 || res.status === 503) {
    throw new Error(
      `${path} → ${res.status} ${JSON.stringify(body)}\n` +
        'The analytics worker (amable-edge) is not reachable: start core + edge together with `pnpm dev` ' +
        '(or point SEED_BASE_URL at an instance started by scripts/dev.mjs).',
    );
  }
  if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(body)}`);
  return body;
}

const report = await post(
  `/api/dev/analytics/traffic?tenant=${tenant}&days=${opt('days', '30')}&per_day=${opt('per-day', '220')}`,
);
console.log(
  `site ${report.siteId}: ${report.sessions} sessions, ${report.events} events, ${report.bots} bot hits, ` +
    `${report.identified} buyers identified; prediction samples ${report.prediction?.samples ?? 0}`,
);
if (report.secret) console.log(`site secret (shown once): ${report.secret}`);

const live = Number(opt('live', '0'));
if (live > 0) {
  const until = Date.now() + live * 1000;
  console.log(`live visitors for ${live}s…`);
  while (Date.now() < until) {
    await post(`/api/dev/analytics/live?tenant=${tenant}&count=${1 + Math.floor(Math.random() * 3)}`);
    await new Promise((r) => setTimeout(r, 2500));
  }
}
