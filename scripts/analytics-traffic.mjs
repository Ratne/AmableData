#!/usr/bin/env node
/**
 * Local demo traffic for web analytics (dev only, after `pnpm seed`):
 *
 *   node scripts/analytics-traffic.mjs [--days 30] [--per-day 220] [--live 120]
 *     [--funnel-visitors 400] [--clicks 5] [--no-funnel] [--tenant demo] [--seed amable-demo]
 *
 * Calls the dev routes of apps/core (`ENVIRONMENT=dev`): creates the demo site if
 * missing, generates sessions over the period (channels, campaigns, geo, devices,
 * goals, bots), identifies seeded CRM contacts before their real payments so CRM
 * revenue gets attributed, runs the CRM sync, demo funnels / segments / alert /
 * share link / integrations and trains the prediction model.
 *
 * Funnel tracking demo (skipped with `--no-funnel`):
 *   - `/api/dev/analytics/funnel-demo` creates the demo funnel (traffic → rotator →
 *     condition → two landers → offer), a paid social traffic source with tracking
 *     fields, an ad connection on the fake ad platform client (synced campaigns and
 *     daily spend) and `--funnel-visitors` funnel visitors over `--days` (entrances,
 *     lander views, action clicks, offer views, returning visitors);
 *   - the converting offer views are sent to the edge postback route
 *     (`/s/{siteId}/pb`, with `conversion_time`), so conversions, attribution and
 *     the outbound conversion queue take the production path;
 *   - `--clicks N` more visitors go live through the real tracking link, action
 *     link and postback of the edge (`/go`, `/a/1`, `/pb`).
 * The edge worker is reached at SEED_EDGE_URL (default http://localhost:8788).
 *
 * `--live N` then keeps a few visitors online for N seconds (realtime view and globe).
 */
const BASE_URL = process.env.SEED_BASE_URL ?? 'http://localhost:8787';
const EDGE_URL = (process.env.SEED_EDGE_URL ?? 'http://localhost:8788').replace(/\/+$/, '');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);
const tenant = opt('tenant', 'demo');
const seed = opt('seed', 'amable-demo');
const days = opt('days', '30');

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

/** GET on the edge without following redirects. */
async function edge(path, headers = {}) {
  const res = await fetch(`${EDGE_URL}${path}`, {
    redirect: 'manual',
    headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129.0 Safari/537.36', ...headers },
  });
  if (res.status >= 400) throw new Error(`edge ${path} → ${res.status} ${await res.text()}`);
  return res;
}

const report = await post(
  `/api/dev/analytics/traffic?tenant=${tenant}&days=${days}&per_day=${opt('per-day', '220')}&seed=${seed}`,
);
console.log(
  `site ${report.siteId}: ${report.sessions} sessions, ${report.events} events, ${report.bots} bot hits, ` +
    `${report.identified} buyers identified; prediction samples ${report.prediction?.samples ?? 0}`,
);
if (report.secret) console.log(`site secret (shown once): ${report.secret}`);

if (!flag('no-funnel')) {
  const demo = await post(
    `/api/dev/analytics/funnel-demo?tenant=${tenant}&days=${days}&visitors=${opt('funnel-visitors', '400')}&seed=${seed}`,
  );
  const prefix = `/s/${demo.siteId}`;
  let converted = 0;
  for (const pb of demo.postbacks) {
    const q = new URLSearchParams({
      hit: pb.hit,
      rev: pb.rev,
      tx: pb.tx,
      conversion_time: String(pb.conversion_time),
      pii_email: `buyer+${pb.tx.toLowerCase()}@example.com`,
    });
    await edge(`${prefix}/pb?${q}`);
    converted += 1;
  }
  console.log(
    `funnel ${demo.funnelId} / source ${demo.trafficSourceId}: ${demo.visitors} visitors, ${demo.touches} new touches, ` +
      `${converted} postbacks, ${demo.spendRows} spend rows (connection ${demo.connectionId ?? 'none'})`,
  );

  const clicks = Number(opt('clicks', '5'));
  for (let i = 0; i < clicks; i += 1) {
    const campaign = demo.campaigns[i % demo.campaigns.length];
    const entrance = await edge(
      `${prefix}/go/${demo.funnelId}-${demo.trafficSourceId}?cid=${encodeURIComponent(campaign)}&fbclid=live-${Date.now()}-${i}&placement=feed`,
    );
    const landing = new URL(entrance.headers.get('location'));
    const vid = landing.searchParams.get('vid');
    const click = await edge(`${prefix}/a/1?vid=${vid}&rn=${landing.searchParams.get('n')}`);
    const hit = new URL(click.headers.get('location')).searchParams.get('s1');
    if (hit && i % 2 === 0) await edge(`${prefix}/pb?hit=${hit}&rev=${(59 + i * 10).toFixed(2)}&tx=LIVE-${Date.now()}-${i}`);
  }
  if (clicks > 0) console.log(`${clicks} live clicks through ${EDGE_URL}${prefix}/go/…`);
}

const live = Number(opt('live', '0'));
if (live > 0) {
  const until = Date.now() + live * 1000;
  console.log(`live visitors for ${live}s…`);
  while (Date.now() < until) {
    await post(`/api/dev/analytics/live?tenant=${tenant}&count=${1 + Math.floor(Math.random() * 3)}`);
    await new Promise((r) => setTimeout(r, 2500));
  }
}
