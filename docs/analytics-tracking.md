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
13. [Development and tests](#development-and-tests)

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

- `identity_keys` maps keys to visitors: `email` (normalized, plus its SHA-256 so a hashed
  `he=` link parameter matches), `phone` (E.164 digits), `session`, `ip`. Keys come from tracker
  identify events (form capture sends phone-only identifies too), payments, `he=` landing links
  and CRM contacts.
- `visitor_merges` links a child to an origin with a mechanism (`email`, `phone`, `session`,
  `manual`). Automatic mechanisms can be switched off per site; the visitor first seen stays the
  origin. Merges are reversible (`unmergeVisitors`) and an explicit disconnection is respected by
  later automatic merges. Visitor rows are never rewritten.
- Queries group by the origin through the recursive `VISITOR_ORIGIN_CTE`, so a merge changes
  journeys and attribution retroactively, including conversions recorded before it.
- Touches of anonymous visitors expire after 90 days; once the group of a visitor is identified
  (email/phone key or CRM contact) its touches are kept.
- GDPR: the keys of a deleted visitor go to `identity_blacklist`; future events carrying them are
  dropped and no conversion carrying them is forwarded.

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

- every hour pulls the current day's spend at campaign level and the new entities (id → name);
- once per local day (from 03:00 in the account's time zone) reconciles the last 7 closed days;
- stores what the platform reports (conversions, revenue) for the reported-vs-actual columns;
- marks a connection `auth_expired` when the platform revokes it, alerts the workspace admins and
  keeps syncing the others.

A manual backfill covers up to 90 days. Spend lands in `ad_spend_daily` (unique on platform +
entity + day, overwritten by each pull). In development, without platform apps configured, a
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
  12 h (5 attempts), permanent errors fail at once, `auth_expired` flags the connection and holds
  the queue. Platforms that need the click to settle (Google Ads) wait 6 hours. Failed jobs can be
  re-sent one by one or in bulk from the outbound log.

## Custom tracking domains

A site can serve its links on its own hostname (`track.customer.com` CNAME → the tracking target).
The core provisions the hostname (custom hostnames API; a fake provider in dev advances
`pending_dns → pending_ssl → active`) and keeps a global index; the edge resolves active hostnames
to the site (cached per isolate). Links on a custom domain have no `/s/{siteId}` prefix and a root
visitor cookie; the shared edge host keeps one cookie path per site.

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
| `GET /funnels-v2/{id}/heatmap` | Visits, flow %, CVR and ROI per node and edge for the canvas overlay |

Rows whose key is null are the unattributed share. Cost comes from the synced spend of the
platforms that have some in the range, else from the per-click cost of the touches.

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
