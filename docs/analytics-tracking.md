# Funnel tracking and ad attribution

How AmableData follows a visitor from an ad click to a sale, credits the sale to the ads that
earned it, and sends the conversion back to the ad platform. This is the internal architecture:
where each piece lives, what it stores and the rules every change has to keep.

The feature extends the web analytics module (tracker, ingest, `AnalyticsDO`); read
[the analytics code](../apps/edge/src/analytics) alongside this page.

## Contents

1. [Overview](#overview)
2. [Funnel graph](#funnel-graph)
3. [Tracking links](#tracking-links)
4. [Entrance, action and postback routes](#entrance-action-and-postback-routes)
5. [Funnel sessions and the data buffer](#funnel-sessions-and-the-data-buffer)
6. [Traffic sources and tracking fields](#traffic-sources-and-tracking-fields)
7. [Identity and visitor merges](#identity-and-visitor-merges)
8. [Attribution models](#attribution-models)
9. [Ad spend sync](#ad-spend-sync)
10. [Outbound conversions](#outbound-conversions)
11. [Custom tracking domains](#custom-tracking-domains)
12. [Reports](#reports)
13. [Custom conversions](#custom-conversions)
14. [Event pipeline and contact data](#event-pipeline-and-contact-data)
15. [Development and tests](#development-and-tests)

## Overview

```
ad click ──▶ edge /go/{funnel}-{source} ──302──▶ lander (tracker /e) ──▶ /a/{n} ──302──▶ offer
                    │                                  │                   │
                    ▼                                  ▼                   ▼
             AnalyticsDO (site): touches, funnel_sessions, identity_keys, visitor_merges
                    ▲                                                      │
shop / network ── /pb?hit=…&rev=…&tx=… ──▶ conversion_log ──▶ outbound queue ──▶ ad platform
                                                  │
core cron: entities + daily spend ─▶ ad_spend_daily ┴─▶ reports (core REST ─▶ web UI)
```

| Piece | Where |
| --- | --- |
| Contracts (zod + types) | `packages/api-types/src/analytics/` (`funnel-graph.ts`, `traffic-sources.ts`, `ads.ts`, `attribution-reports.ts`) |
| Funnel engine (pure, no I/O) | `apps/edge/src/analytics/funnel-engine/` |
| Link routes `/go`, `/a`, `/pb` | `apps/edge/src/analytics/link-routes.ts`, `links/` |
| Storage (SQLite of the site DO) | `apps/edge/src/analytics/store/` (migration 3 and later in `migrations.ts`) |
| Outbound conversions (DO alarm) | `apps/edge/src/analytics/outbound-worker.ts`, `store/outbound.ts` |
| Ad platform clients | `packages/ads-providers` (fetch and clock injected, fake client for dev) |
| Spend sync, OAuth, REST API | `apps/core/src/analytics/` (`ads-sync.ts`, `routes-*.ts`) |
| Tracker (form capture, action links) | `packages/tracker/src/` (`capture.ts`) |
| UI | `apps/web/src/features/analytics/` (`funnel-builder/`, `reports-ads/`, `sources/`) |

Invariants that hold everywhere:

- **Links are stateless and permanent.** A tracking link is derived from (funnel id, traffic
  source id) and is never stored; editing weights, pages or rules never breaks a live link.
  Funnels, sources and nodes are archived or soft-deleted, never removed.
- **Every decision has a fallback.** The engine always answers with a destination.
- **The click-log is immutable, attribution is computed at read time.** Touches are never
  rewritten; a new identity or merge changes the reports retroactively.
- **Only configured tracking fields are stored.** Other URL parameters feed `{data-*}` tokens for
  the request and are gone; PII received by postback only reaches the outbound queue, hashed
  before it leaves.
- **Writes are idempotent on an external key** (touch id, hit + event + tx, outbound event id).
- Money in minor units, timestamps in epoch ms, JSON fields in snake_case.

## Funnel graph

A funnel (`FunnelGraph`) is a versioned directed graph. Nodes:

| Kind | Role | Exits |
| --- | --- | --- |
| `traffic` | Entry point of the tracking links (exactly one) | `default` |
| `rotator` | Weighted split; stickiness `none`, `sticky` (same branch again) or `anti_affinity` (cycles through every branch) | `weight` |
| `condition` | Routes in priority order; a route matches when all its groups match (`any`/`all` rules on country, region, city, device, OS, browser, language, referrer, local hour, weekday, tag, traffic source, campaign, `field:<name>`) | `route` + mandatory `default` |
| `page_group` | Lander or offer pages shown to the visitor, weighted, pausable; `map_action_to_page` sends action N to page N | `action` (numbers) + `default` when it has exits |
| `external_url` | Redirect outside the funnel | none |
| `action_proxy` | Pass-through to group action links | `default` |
| `tag` | Adds/removes visitor tags (used by conditions) | `default` |
| `webhook` | Fires an HTTP call in the background (private targets blocked, timeout) | `default` |

`validateGraph` (shared by the API, the editor and the engine) rejects graphs without a traffic
node, with unknown edges or routes, non-positive weights, decision nodes without a fallback,
empty page groups, cycles without an exit and unreachable nodes. Updates carry the version they
were based on: a stale version answers `409`.

`executeStep(graph, state, event, ctx, rng, now)` walks the server-side nodes from the entry (or
from the page the action was clicked on) to the next page or external URL, and returns the
destination, the path, the tag and webhook effects and the next session state. It never touches
storage; the random source and the clock are injected so tests are deterministic.

## Tracking links

All links are built by `funnel-engine/links.ts` and previewed by
`GET /funnels-v2/{id}/links` (link builder in the UI):

- **Entrance:** `{base}/go/{funnelId}-{sourceId}[/{nodeId}[/{pageId}]]?{fields}` where the fields
  are the traffic source's tracking fields with their platform macros (`cid={{campaign.id}}`…).
  Optional `c=` sets the cost of the click (`c=0.25`, `c=cpm_2000`).
- **Action:** `{base}/a/{n}` on the page (the tracker appends `vid` and `rn`), with the fallback
  form `{base}/go/{funnelId}/{nodeId}/a/{n}` that carries default parameters.
- **Direct link:** the page URL itself plus `f, ts, n, p` and the fields, for ads that must point
  at the page (no redirect). The tracker reports the landing and the edge records its entrance.

`{base}` is a custom tracking domain of the site, or the shared edge host with the site in the
path (`https://<edge>/s/{siteId}`). Reserved parameters (`vid n c ts f p hit rev tx rn`) can never
be used by tracking fields or data passing.

## Entrance, action and postback routes

`createLinkRoutes()` mounts the routes on both host forms.

**`GET /go/…` (entrance).** Resolves the site (hostname or `/s/{siteId}`), the funnel and the
source; reuses the visitor of `vid` or of the `amb_fvid` cookie, else creates one; captures the
tracking fields; runs the engine; records an `entrance` touch (with the cost) and a `view` touch
of the destination page in one DO call; delivers webhook effects in the background; answers `302`
to the page with `vid` and `n` appended and the data-passing tokens resolved. Bots are
redirected without touches. Unknown host, funnel or source answer `404`.

**`GET /a/{n}` (action).** Finds the origin page in this order, so it works without cookies:
explicit `vid` + `rn` → the referrer (`vid`, `n` or the page URL) → the visitor cookie → the
default funnel/node of the path (only when no session is known). Records a `click` touch on the
origin page and a `view` of the destination.

**`GET /pb` (conversion postback).** Server to server. Identifies the converting hit by `hit`
(the `{hit}` token passed to the offer) or by `vid` [+ `p`]. Parameters: `rev` (major units),
`tx`, `event` (`sale`/`lead`), `status` (`pending` stores 0.01, `rejected` reverses an existing
conversion and never creates one), `rev_share` (%), `conversion_time` (seconds or ms, never before
the hit nor in the future), `disable_postbacks`, `consent=0`, and pass-through PII `pii_email`,
`pii_phone`, `pii_ip`, `pii_ua`. The conversion is written idempotently on hit + event + tx
(`conversion_log`), then approved conversions are queued for the ad platform. `GET /pb/event`
records numbered custom events (`e=1..10`, deduplicated per hit).

**Tracker side.** On a funnel page the tracker sends the funnel context with its events
(`dl: {f, ts, n, p, vid}`) and decorates action links with `vid` + `rn`. On the landing of a
redirect (URL carrying the funnel `vid`), the edge links the tracker visitor to the funnel
visitor (a `session` merge), so the page's identify, goals and payments join the click-log of
the same person. On a direct-link landing (`f` + `ts` in the URL, no `vid`) the edge records the
entrance and view touches itself.

## Funnel sessions and the data buffer

`funnel_sessions` holds, per (visitor, funnel), the node and page the visitor is on (origin of
the next action), the rotator history and the tracking fields captured at the entrance, so later
touches of the visit carry the same campaign, click id and fields. Tags live in `visitor_tags`.
Sessions expire after 90 days.

The data buffer is the set of URL parameters of the current request that are not tracking
fields: they resolve `{data-name}` tokens in the destination URL and are never persisted.
Available tokens: `{hit} {visitor} {campaign} {external} {funnel-id} {trafficsource-id}
{current-node-id} {country} {device} {browser} {os} {payout} {txid} {data-*}`; a missing value
resolves to an empty string. Data passing merges base URL → page level → node level (the last one
wins per key).

## Traffic sources and tracking fields

A traffic source describes where clicks come from:

- two reserved fields, `campaign` and `external` (the platform click id: `fbclid`, `gclid`,
  `ttclid`…), whose URL parameter can be renamed but which cannot be removed;
- up to 20 custom fields in slots `c1`…`c20` (`name`, `url_param`, `source_token`, `append`);
  renaming keeps the slot, so stored data stays readable;
- cost type (`cpc`, `cpm`, `cpa`, `revshare`, `none`) and default cost, cost/revenue modifiers;
- conversion config: the ad connection and the mapping from conversion events (`sale`, `lead`,
  `event:N`) to platform events, the zero-revenue skip and the postback throttle.

Templates for the supported platforms (`GET /traffic-sources/templates`) come with the right
macros. Touches store the captured slots (`fields`), the campaign and the click id; reports map
the slots holding adset and ad ids to the synced ad entities.

## Identity and visitor merges

A person may show up as several visitor ids: the funnel visitor of the redirects, the tracker
visitor of each domain, other devices. The store keeps them apart and links them:

- `identity_keys` maps keys to visitors: `email` and `phone` as SHA-256 of the normalized value
  (lowercase email, E.164 digits), so a hashed `he=` link parameter matches directly, plus
  `session` and `ip`. Keys come from tracker identify events (form capture sends phone-only
  identifies too), payments, `he=` landing links and CRM contacts. The clear values never reach
  the store: see [Event pipeline and contact data](#event-pipeline-and-contact-data).
- `visitor_merges` links a child to an origin with a mechanism (`email`, `phone`, `session`,
  `ip_ua`, `device_ip`, `manual`). Automatic mechanisms can be switched off per site; the visitor
  first seen stays the origin. Merges are reversible (`unmergeVisitors`) and an explicit
  disconnection is respected by later automatic merges. Visitor rows are never rewritten.
- Queries group by the origin through the recursive `VISITOR_ORIGIN_CTE`, so a merge changes
  journeys and attribution retroactively, including conversions recorded before it.
- Touches of anonymous visitors expire after 90 days; once the group of a visitor is identified
  (email/phone key or CRM contact) its touches are kept.
- GDPR: the keys of a deleted visitor go to `identity_blacklist`; future events carrying them are
  dropped and no conversion carrying them is forwarded.
- `ip_ua` and `device_ip` are guesses, off by default. An opt-out or an erasure does not extend
  to the other visitor, and an opt-out cuts the link (the other visitor goes on as its own
  person). Two visitors of one group that gave the same email or phone are one person all the
  same, where the site merges by that key: they are suppressed together. The identity reprocess
  never rebuilds a guess.

### Device signals and `device_ip`

- Site setting `device_signals` (off by default, never on a cookieless site). When on, the
  `GET /e` handshake answers `device: true` and the cookie builds load the module `…-d.js` next
  to the tracker (`/s-d.js`, or `/<dir>/<name>-d.js` on a neutral path), never with Global Privacy
  Control, after an opt-out, for bots or where the tracker itself is off. It sends one `device`
  event per browser session: screen and pixel density, cores, memory, touch points, platform,
  GPU, languages, system preferences, fonts, canvas and audio hashes, UA client hints. It is a
  fingerprint: the site owner turns it on and covers it in the cookie banner. A self-hosted copy
  of the tracker looks for the module next to itself (`<name>-d.js`); one served under a name
  without `.js` loads none.
- The edge drops `device` events while the setting is off or on cookieless visits, and so does
  the site DO when the setting was turned off while an event was on its way (edge cache, queue,
  replay). The DO keeps the latest signals per visitor (`device_signals`) and the sightings of
  device key + network (`device_ip_seen`, 14 days). The device key hashes only signals the
  browsers of one device share (screen, density, colour depth, cores, touch points, platform,
  GPU, time zone), so an in-app browser and Safari on one phone match; canvas, audio, fonts and
  the client hints only feed the measurements. The network is a keyed hash of the IPv4 address or
  the IPv6 /64. The address counts only when the visitor's own is known: the browser says it
  sent the event straight to this host (`Sec-Fetch-Site`: `cross-site` to the shared host,
  `same-site` to a tracking domain of the page's site, `same-origin` to the page's own host), or
  a proxy recipe with the key forwards it. An event relayed by the page's server (rewrite recipes:
  sent to the page's site, it reaches another host), one without the header (browsers before it,
  Safari until 16.3; plain-http relays) and a proxy with the key and no usable address carry what
  may be a server's address, the same for every visitor: the signals are kept, no network is
  taken and the rule never acts. A proxy that forwards a balancer's address instead of the
  visitor's (nginx behind a CDN without `real_ip`) cannot be told apart.
- Rule `device_ip`: a new visitor (first seen within a day) joins the only person seen with the
  same device key on the same network in the last 7 days; more than three visitors on the pair
  means a shared network, no merge, and a visitor that opted out is never a match (nobody merges
  into a tombstone). The match is recorded even while the rule is off, for the
  measurements (`GET /sites/{id}/device-signals`: visitors with signals, distinct devices,
  uniqueness and stability per system and browser, matches and precision on visitors known by
  email). `POST /sites/{id}/device-signals/unmerge` disconnects some or all of its merges.
- Turning the setting off, or deleting the site, deletes both tables, and the DO keeps nothing
  that still arrives. An erasure deletes the visitor's rows and the matches pointing at it;
  visitors forgotten after 13 idle months lose theirs too, and the daily retention drops the
  sightings past 14 days. The R2 archive (`events/`, `corrections/`, `poison/`) never holds the
  signals: the `device` event is archived without them. Segments parked because the DO could not
  apply them carry the full event, like every other event: `wal-pending/` until the replay,
  `wal-stale/` until someone reconciles it.

## Attribution models

Reports credit each conversion to the arrivals (entrance touches) of the person's path up to the
conversion; `node` grouping credits every funnel touch instead. Weights sum to 1:

| Model | Credit |
| --- | --- |
| `first_click` | All to the first arrival |
| `last_click` (default) | All to the last arrival |
| `linear` | Equal shares |
| `u_shaped` | 40% first, 40% last, 20% split among the middle ones (one arrival: 100%, two: 50/50) |
| `time_decay` | Weight 2^(−age / 7 days), age = conversion time − touch time |
| `windowed_hybrid` | First arrival when it is within `window_days` (1–30, default 7) of the conversion, else last |

Basis `click_date` reports a conversion in the period of the credited touch (later sales
included); `sale_date` reports the conversions of the period. Revenue comes from the conversion
log and from the payments of the person (CRM and tracker payments; a payment whose transaction id
is the `tx` of a logged conversion is the same sale).

## Ad spend sync

Connections are created through OAuth (`/ads/connections/{platform}/connect` and `/callback`);
grants are sealed in the installation database and refreshed before expiry. The core cron:

- every hour pulls the current day's spend at every level (campaign, adset and ad: one call per
  level) and the new entities (id → name, with their parent);
- once per local day (from 03:00 in the account's time zone) reconciles the last 7 closed days;
- stores what the platform reports (conversions, revenue) for the reported-vs-actual columns;
- marks a connection `auth_expired` when the platform revokes it, alerts the workspace admins and
  keeps syncing the others.

A manual backfill covers up to 90 days, at the same three levels. Spend lands in
`ad_spend_daily` (unique on platform + entity + day, overwritten by each pull). The levels are
never added up: grouped by campaign, adset or ad, the performance report reads one level per
platform (the coarsest synced one at or below the grouping, so an ad row gets the ad's own
spend); grouped by anything else, it reads the coarsest synced level (normally campaign). In development, without platform apps configured, a
deterministic fake client stands in for every platform.

## Outbound conversions

An approved conversion with a mapped event becomes one job per connection in
`outbound_conversions`:

- `event_id = sha256(connection_id | tx | kind)` (the conversion id when there is no `tx`; custom
  events add their number). The same sale reported twice (postback retry, CRM sync) maps to the
  same job; the event id is also the deduplication key shared with the browser pixel.
- The payload carries event name, time, value, currency, order id, the platform click ids found
  on the person's sessions and touches, and `external_id`. Email, phone, IP and user agent stay in
  the job only while it is pending, and are dropped once it is sent, failed or skipped. The
  platform client normalizes and hashes them (SHA-256) before sending.
- Gates, recorded as `skipped` jobs without PII: no consent, zero revenue when the source skips
  it, the source throttle, blacklisted keys, non-approved status.
- The DO alarm sends due jobs in batches; retryable errors back off 1 min, 5 min, 30 min, 2 h,
  12 h (6 attempts in total), permanent errors fail at once, `auth_expired` flags the connection and holds
  the queue. Platforms that need the click to settle (Google Ads) wait 6 hours. Failed jobs can be
  re-sent one by one or in bulk from the outbound log.

## Custom tracking domains

A site can serve its links on its own hostname, in one of two ways (`kind` of the domain):

- **`zone`** (default in the UI, no extra configuration): the domain is a zone of the same
  Cloudflare account as the edge worker. The owner adds the zone, a proxied CNAME record for the
  hostname and a worker route (`host/*` → the edge worker); the certificate is the zone's own.
  The core verifies the domain by probing `GET /.well-known/amable-tracking` on it, which the edge
  answers on every host with `{ "service": "amable-edge" }`: one good answer proves DNS, proxy,
  certificate and route at once (`pending_dns → active`; a wrong answer is an `error`). In dev the
  probe succeeds immediately.
- **`cname`** (needs `CF_ZONE_ID` + `CF_API_TOKEN`, see `apps/core/wrangler.jsonc`): the DNS stays
  wherever it is and the owner only adds a CNAME; the core provisions a custom hostname on the
  platform zone (custom hostnames API; a fake provider in dev advances
  `pending_dns → pending_ssl → active`), which issues the certificate.

Either way the installation D1 keeps the global hostname index; the edge resolves active hostnames
to the site (cached per isolate), and a cron re-checks pending domains a few per tick. Links on a
custom domain have no `/s/{siteId}` prefix and a root visitor cookie; the shared edge host keeps
one cookie path per site.

## Reports

All under `/api/v2/t/{slug}/analytics`, with `site_id`, `from`/`to` (inclusive local days) and
optional `timezone`:

| Endpoint | What |
| --- | --- |
| `GET /ads-reports/performance` | Visits, clicks, cost, attributed and total revenue, profit, ROAS, ROI, sales, leads, AOV, CPA, CVR, reported vs actual, grouped by platform, source, campaign, adset, ad, day, funnel, node, country or device; drill-down filters; `model`, `window_days`, `basis` |
| `GET /ads-reports/ltv` | Revenue per customer at 30/60/90/180/365 days from the first click, by source, campaign or platform |
| `GET /ads-reports/cohorts` | Weekly or monthly cohorts of first clicks with cumulative revenue and ROI at 0/30/60/90 days |
| `GET /ads-reports/journeys` | Most frequent paths (by source, campaign or node) with conversions and revenue |
| `GET /ads-reports/tracking-quality` | Share of conversions with a resolved identity, with a platform click id, with a funnel touch; `score` is their mean |
| `GET /conversions/report` | Custom conversions per rule, credited to a source dimension (channel, UTM, entry page, ad campaign / set / ad) with a legacy attribution model, plus the latest 20 with their entry page and ad |
| `GET /funnels-v2/{id}/heatmap` | Visits, flow %, CVR and ROI per node and edge for the canvas overlay |

Rows whose key is null are the unattributed share. Cost comes from the synced spend of the
platforms that have some in the range, else from the per-click cost of the touches.

## Custom conversions

Site rules that turn a pageview ("reached `/thank-you`", exact, prefix or substring, optional
hostname) or a goal into a conversion, whatever the entry page and however many visits it took.
`once` counts the first match of a visitor, `every` each match; an optional fixed value is in
the site currency.

- **Storage:** `conversion_rules` (AnalyticsDO migration 11, `store/conversion-rules.ts`).
  Conversions are `conversion_log` rows with `source = 'rule'`, `event = 'event:N'`
  (N 100–999, freed on delete) and `hit = 'r:<visitorId>'`; `UNIQUE(hit, event, tx)` makes them
  idempotent (`tx` is empty for `once`, `pv:<id>` / `g:<id>` for `every`).
- **Ingest:** each new pageview and goal (tracker or CRM) is checked against the enabled rules.
  A page rule also records a goal named after the rule `key`, so alerts, automations, funnels
  the realtime feed and the automations (`goal` trigger) see it; goals written by rules never trigger rules.
- **Backfill:** `backfill: true` on create converts the raw pageviews / goals still in
  retention in one `INSERT … SELECT`, without goals.
- **Reports:** `/conversions/report` credits each conversion to the sessions of the person
  (a CRM contact across its visitors, else the visitor) before it. The performance report adds
  `conversions`, `cost_per_conversion_minor` and `conversion_rate`, credited over the arrival
  touches with the V2 models; `conversion_id` restricts them to one rule. The ad only shows
  there for traffic that came through funnel or traffic-source links.
- **API:** `GET/POST /conversions`, `PATCH/DELETE /conversions/{id}` (writers:
  `analytics:configure` or `reports:create`).

## Event pipeline and contact data

```
tracker / server API ──▶ edge ingest ──┬─▶ queue analytics ──▶ R2 archive (WAL) ──▶ AnalyticsDO ──▶ ack
                                       │         └─ exhausted ─▶ analytics-dlq ─▶ DO, or parked on R2
                                       │                                         (edge cron */5 replays)
                                       └─▶ queue registry ──▶ core: workspace registry (CRM)
                                                 └─ exhausted ─▶ registry-dlq ─▶ parked on R2
                                                                                (operations page replays)
```

- Every event has an id (`eid`); the DO drops an id it has applied in the last 7 days, so the WAL,
  the DLQ and the replays can redeliver freely.
- The ingest splits contact data off the event: clear emails, phones and names go only to the
  `registry` queue, consumed by the core into the workspace registry (`crm_identity_hashes`,
  contacts, the compact web journey on the contact timeline). The `analytics` queue, the DO and the
  R2 archive see their SHA-256 hashes. Form traits matching contact fields are dropped from the
  visitor traits.
- The DO keeps raw rows for the site's retention (30 to 395 days, default 90); R2 keeps the
  archive from ingest on.
- Sites created before this pipeline stored clear values. On boot each `AnalyticsDO` converts them
  page by page (`store/legacy.ts`: identity keys and blacklist, visitor email, name and contact
  traits, payment emails), then marks `analytics_meta.legacy_hashed`. The core indexes the
  contacts that already existed in `crm_identity_hashes` through
  `analytics.backfillIdentityHashes`, called by the sync until it reports `done`.
- Per-site neutral paths (`/<dir>/<name>` for events and the cookie mode, `/<dir>/<name>.js` for
  the script, `-l`, `-h` and `-d` variants included) look like landing page paths. The edge takes them only when the directory contains a
  digit (`SCRIPT_PATH_RE`) and, for the mode `GET`, only with `?site=`; anything else goes on to the
  landing pages, forms and the page catch-all.
- A customer proxy forwards the visitor IP, host and geo in `x-amb-*` headers, trusted only with the
  site's proxy key.

## Development and tests

- `node scripts/analytics-traffic.mjs` (with `pnpm dev` running) fills the demo tenant: web
  traffic, then the demo funnel, a paid traffic source, a fake ad connection with spend, funnel
  visitors over the period and their conversions sent through the edge postback route, plus a few
  live clicks through `/go` and `/a`. See the header of the script for the options.
- `apps/edge/test/e2e-flow.test.ts` runs the whole chain on the real routes and store: entrance
  on the shared host, tracker pageview, action link, postback, the six models with hand-computed
  values, the outbound job and the request sent to the platform, the merged journey.
- Engine, storage, routes, outbound, reports and identity have their own suites in
  `apps/edge/test/`; the REST API in `apps/core/test/analytics/`; the tracker in
  `packages/tracker/test/`; UI state and i18n coverage in `apps/web/test/`.
