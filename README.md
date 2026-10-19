<div align="center">

<img src="./apps/web/public/brand/logo.png" alt="amable logo" width="120" />

# amable

**The all-in-one open-source CRM that runs entirely on Cloudflare Workers, inside your own account.**

Open source & free to self-host, by [amabledata](https://amabledata.com).

[![Latest release](https://img.shields.io/github/v/release/Ratne/AmableData?labelColor=grey&color=c9503a&label=Latest%20release&style=for-the-badge)](https://github.com/Ratne/AmableData/releases)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-c9503a?labelColor=grey&style=for-the-badge)](LICENSE)
[![Runs on Cloudflare Workers](https://img.shields.io/badge/runs%20on-Cloudflare%20Workers-c9503a?labelColor=grey&style=for-the-badge)](https://workers.cloudflare.com)

[Website](https://amabledata.com) · [Cloud](https://app.amabledata.com) · [Issues](https://github.com/Ratne/AmableData/issues) · [Discussions](https://github.com/Ratne/AmableData/discussions) · [Contributing](CONTRIBUTING.md)

</div>

## What is amable?

amable is a complete CRM, marketing and sales platform that you deploy on **your own
Cloudflare account**: contacts and companies, visual automations, email broadcasts,
e-commerce, forms, booking calendars, landing pages, web analytics with revenue
attribution, a REST API and reports, all in one product.

There are no servers to maintain. Everything runs on Workers, Durable Objects, D1, R2
and Queues, so it scales to zero when idle and stays fast everywhere.

Your data stays in your account. Every installation is identical: schema migrations run
automatically when the workers boot, so upgrading is just a deploy.

## What can amable do?

- **CRM:** contacts, companies, opportunities, tags, 24 custom field types, notes, tasks,
  appointments, activity timeline, merge, CSV import, full-text search and saved
  searches as segments.
- **Automations:** a visual canvas builder with goals (tag applied, form submitted,
  product purchased, email opened or clicked, lead score, …), sequences, timers,
  decisions, HTTP requests and per-node reports.
- **Email marketing:** templates with a block editor and Liquid personalization,
  broadcasts with time-zone delivery and throttling, open and click tracking, one-click
  unsubscribe, suppressions, warm-up, bounce and complaint handling.
- **E-commerce:** catalog, orders, promo codes, payments and refunds, subscriptions
  with billing automation, invoices.
- **Forms and bookings:** an embeddable form widget, encrypted submissions, webhook,
  Google Sheets and email connectors; calendars with availability, multiple hosts,
  buffers, reminders and Google Calendar sync.
- **Landing pages:** a section-based page builder, server-side rendered on your domain,
  with SEO settings and versions.
- **Web analytics:** a first-party tracker served from your domain, goals, funnels,
  revenue attribution, realtime and journeys linked to CRM contacts.
- **Reports and dashboards:** about 30 built-in reports, custom reports and CSV export.
- **Developers:** REST API v2 with an OpenAPI reference (`/docs/api`), API keys and
  signed outgoing webhooks with retries and replay.
- **Security:** Argon2id passwords, mandatory 2FA (TOTP or email codes), magic links,
  roles and permissions, step-up for sensitive actions, CSP with nonces, CSRF
  protection, rate limiting, Turnstile, SSRF-safe fetch, audit log and daily R2 backups.

English and Italian UI, light and dark theme.

## Quick start

You need a Cloudflare account on the **Workers Paid** plan (Durable Objects, Queues)
with R2 enabled, Node.js ≥ 20 and pnpm (`corepack enable pnpm`).

```bash
git clone https://github.com/Ratne/AmableData.git && cd AmableData
pnpm install
pnpm exec wrangler login

pnpm self-host:setup --deploy \
  --app-origin https://amable-core.<your-subdomain>.workers.dev \
  --owner-email you@example.com --workspace "My company"
```

The setup script provisions D1, R2 and the queues, deploys both workers, sets the
secrets and prints the invitation link for the first owner. It is idempotent (rerun it
after `git pull` to update), never overwrites existing secrets and supports `--dry-run`
to print every command first. You can [review the script](scripts/self-host-setup.mjs)
before you run it.

To update, check out the new [release](https://github.com/Ratne/AmableData/releases) and
rerun the script: `git fetch --tags && git checkout <tag> && pnpm install && pnpm self-host:setup --deploy`
(same options). Once a day the app asks GitHub for the latest release and shows workspace
owners a notice when a newer one exists; set the variable `UPDATE_CHECK=off` to disable it.
Watch the repository for releases to get them by email.

Or deploy the core worker in one click:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Ratne/AmableData/tree/main/deploy/cloudflare)

The button deploys the dashboard, CRM, automations, email and API with
`deploy/cloudflare/wrangler.jsonc`, and asks for the secrets listed in
`deploy/cloudflare/.dev.vars.example`. Then add the edge worker (tracking, hosted
forms, booking and landing pages, email link redirects) and the first owner with
`pnpm self-host:setup --deploy`. The edge cannot read the `EDGE_GATEWAY_SECRET` you gave
the button, so the script sets a new one on both workers.

Lost or expired the first-owner link? Rerun the script with the same `--owner-email`
while nobody has signed up yet: it issues a new link for the same workspace and the old
one stops working.

<details>
<summary><b>After the first deploy</b></summary>

| What                                      | How                                                                                                                                                                                                                                                         |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| System email (sign-in codes, invitations) | Onboard your domain to Cloudflare Email Sending, uncomment the `send_email` binding `SYSTEM_EMAIL` and set `SYSTEM_EMAIL_FROM`                                                                                                                              |
| Marketing email                           | PostShiba account: secret `POSTSHIBA_API_KEY` (Full access), vars `POSTSHIBA_TEAM_ID` and `POSTSHIBA_CLUSTER_ID`. Each workspace gets its own tenant, SMTP credential and webhook on its first sending domain                                               |
| Custom domains and tracking subdomain     | In-app domain wizard; set `CLOUDFLARE_DNS_API_TOKEN` (Zone DNS + Workers Routes edit) to automate the records                                                                                                                                               |
| Google Calendar                           | Your own Google OAuth client: `GOOGLE_OAUTH_CLIENT_ID`, secret `GOOGLE_OAUTH_CLIENT_SECRET`, redirect URI `<app origin>/oauth/google/callback`. Google Sheets form exports need nothing: workspaces upload their own service account key                    |
| Bot protection                            | `TURNSTILE_SITE_KEY` + secret `TURNSTILE_SECRET_KEY`                                                                                                                                                                                                        |
| Error reports to your own endpoint        | `ERROR_REPORTING=https://…` (default `local`: logs only)                                                                                                                                                                                                    |
| Address autocomplete                      | On by default through the public [Photon](https://github.com/komoot/photon) geocoder (OpenStreetMap data, fair use). Point `ADDRESS_LOOKUP_URL` at your own Photon, or set it to `off` for manual entry only. Workspaces can install the Mapbox app instead |

</details>

## Self-hosted or Cloud

| Self-hosted                                    | amabledata Cloud                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| Deploy amable on your own Cloudflare account.  | We install amable on _your_ Cloudflare account and keep it up to date.               |
| Bring your own email, OAuth and DNS providers. | Central services included: system email, verified Google OAuth app, marketing email. |
| Update when you want.                          | Automatic updates through release channels, fleet monitoring and support.            |
| Free and open source.                          | Paid service with a license key. See [amabledata.com](https://amabledata.com).       |

It is the same application in both cases. Every outside dependency sits behind an
interface and is selected by configuration (`apps/core/src/providers/select.ts`), so a
self-hosted installation never needs the cloud.

<details>
<summary><b>Capability matrix</b></summary>

| Capability                            | Cloud (license key)                                      | Self-hosted default                                   | Local dev   |
| ------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------- | ----------- |
| Marketing email                       | PostShiba tenant provisioned for you                     | Your PostShiba account                                | Console log |
| System email                          | Central notify service                                   | Your `send_email` binding (Cloudflare Email Sending)  | Console log |
| Email quota                           | Wallet quota guard (included volume + prepaid credits)   | Allow all                                             | Allow all   |
| Error reporting                       | Fleet monitor                                            | Local logs, or your own HTTPS endpoint                | Local logs  |
| DNS automation                        | Your Cloudflare zone via API token                       | Your Cloudflare zone via API token, or manual records | Fake        |
| Google OAuth                          | Central verified app (broker)                            | Your own OAuth client                                 | Stub        |
| Payments                              | Recorded via UI / API (no processor in the installation) | Same                                                  | Same        |
| Support, assisted access, ideas board | Portal and in-app                                        | Community (GitHub issues)                             | —           |

</details>

## Architecture

```text
               your Cloudflare account
┌──────────────────────────────────────────────────────────────┐
│ amable-core (Worker)                                         │
│   Hono API /api · SPA assets · cron · queue consumers        │
│   D1: installation (users, sessions, tenants, domains)       │
│   Durable Objects per tenant: TenantDb (CRM, SQLite),        │
│     Engine (automations), MailDb (email), BookingCalendar,   │
│     EditSession                                              │
│   Queues: email-send, webhooks-out, form-submissions,        │
│     esign-seal                                               │
│   R2: files and backups                                      │
│                                                              │
│ amable-edge (Worker, on your domains)                        │
│   tracking ingest · hosted forms · booking and landing pages │
│   email redirects · unsubscribe · AnalyticsDO per site       │
└──────────────────────────────────────────────────────────────┘
```

Domain events flow through a transactional outbox in each tenant's `TenantDb`; the
`Engine` Durable Object drains it to run automations and fan out signed webhooks.

| Path         | What it is                                                                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/core`  | Main worker: API, SPA assets, Durable Objects, queues, cron                                                                                     |
| `apps/edge`  | Edge worker on customer domains                                                                                                                 |
| `apps/web`   | React 18 SPA (Vite, Tailwind v4, TanStack Router/Query)                                                                                         |
| `packages/*` | db (schemas, migrations), core (domain, provider interfaces), api-types, auth, i18n, ui, editor, email-render, builder, forms, booking, tracker |
| `deploy/`    | Self-hosted wrangler templates and the Deploy to Cloudflare config                                                                              |

## Development

```bash
pnpm install
pnpm dev             # tracker + SPA build, then core (8787) and edge (8788) in one wrangler session
pnpm seed            # demo tenant with fake data; prints the local admin credentials
pnpm seed:analytics  # ~30 days of fake web traffic, funnels, alerts, share link (needs `pnpm dev`)
pnpm dev:web         # Vite dev server with /api proxied to apps/core (port 5173)
```

Nothing ever leaves your machine in dev: emails are printed to the console, and OAuth,
DNS and payments use fakes. Copy `.dev.vars.example` to `.dev.vars` in `apps/core` and
`apps/edge` to adjust local variables.

| Command                | Purpose                                                    |
| ---------------------- | ---------------------------------------------------------- |
| `pnpm typecheck`       | TypeScript (strict) across every workspace                 |
| `pnpm test`            | vitest                                                     |
| `pnpm build`           | SPA build + dry-run deploy build of all workers            |
| `pnpm check:names`     | Names rule: no third-party product names in the repository |
| `pnpm self-host:setup` | Self-hosted provisioning and deploy                        |

<details>
<summary><b>How <code>pnpm dev</code> works</b></summary>

`pnpm dev` (`scripts/dev.mjs`) runs both workers in a single `wrangler dev` session,
because the core's AnalyticsDO binding (`script_name: amable-edge`) and the edge's
`CORE` service binding only resolve inside one session. Wrangler exposes only the
first worker over HTTP, so the edge port is a small local proxy that hands requests to
the edge worker; `EDGE_ORIGIN` (snippets, hosted links) and `CORE_ORIGIN` point at the
two local origins.

Options: `--port`, `--edge-port`, `--ip`, `--persist-to`, `--skip-build`. For example,
an isolated second instance:

```bash
node scripts/dev.mjs --port 8897 --edge-port 8898 --ip 127.0.0.1 --persist-to /tmp/amable-dev
SEED_BASE_URL=http://127.0.0.1:8897 pnpm seed
```

Browser cookies are shared across ports of the same host, so sign in to a second
instance through another hostname (e.g. `http://dev2.localhost:8897`). `pnpm dev:edge`
still runs the edge worker alone (no analytics data from the core in that mode).

</details>

## Community and support

- Report bugs and request features in [GitHub Issues](https://github.com/Ratne/AmableData/issues).
- Ask questions in [GitHub Discussions](https://github.com/Ratne/AmableData/discussions).
- Read the [contribution guide](CONTRIBUTING.md) before you submit a change.
- Report vulnerabilities privately as described in the [security policy](SECURITY.md).
- Need a managed installation and support? Visit [amabledata.com](https://amabledata.com).

## License

amable is licensed under the [GNU AGPL-3.0](LICENSE): if you offer a modified version as
a service, you must publish your changes.
