# Building apps for AmableData

An app extends AmableData from the outside: it is a web service you host (a Cloudflare Worker
is the easiest choice) that a workspace installs from the Marketplace, or from a URL while you
develop it. The app gets an OAuth token limited to the scopes the admin accepted, receives
events, answers hooks the CRM calls during its work, and can show screens inside the CRM.

```sh
npx create-amable-app my-app
cd my-app && npm install && npm run dev && npm test
```

The generated project ([template](../../packages/app-cli/template)) already does the plumbing
(install flow, signatures, keys, tokens, screens) with [`@amable/app-sdk`](../../packages/app-sdk)
and ships a first test: you write only the app logic. Three reference apps show complete
integrations with their tests and recorded fixtures:

- [Emailable](../../examples/apps/emailable): email verification. Validation hook and its batch
  variant, an automation action with outputs, an app-owned custom field, tags, settings screen.
- [Kapso](../../examples/apps/kapso): WhatsApp. A conversation channel with a 24-hour reply window
  and templates, provider onboarding through a hosted page, signed provider webhooks, triggers, an
  automation block whose options come from the app, a full page to manage templates.
- [Mapbox](../../examples/apps/mapbox): address autocomplete on the contact editor with the
  workspace's own token, falling back to the built-in OpenStreetMap search.

## Contents

1. [What you can extend](#what-you-can-extend)
2. [API versions](#api-versions)
3. [The manifest](#the-manifest)
4. [Install flow (OAuth)](#install-flow-oauth)
5. [Calls from the CRM and their signature](#calls-from-the-crm-and-their-signature)
6. [Events (webhooks)](#events-webhooks)
7. [Contact validation hook](#contact-validation-hook)
8. [Address lookup](#address-lookup)
9. [Automation actions and triggers](#automation-actions-and-triggers)
10. [Options loaded from the app](#options-loaded-from-the-app)
11. [Form connectors](#form-connectors)
12. [Conversation channels](#conversation-channels)
13. [Screens inside the CRM](#screens-inside-the-crm)
14. [App API](#app-api)
15. [Privacy](#privacy)
16. [Integrating well](#integrating-well)
17. [Tests and fixtures (required)](#tests-and-fixtures-required)
18. [The CLI](#the-cli)
19. [Publishing in the Marketplace](#publishing-in-the-marketplace)
20. [Releasing an update](#releasing-an-update)

## What you can extend

Everything an app adds is declared in the manifest; the CRM shows nothing that is not there.

| You want to… | What users see | Manifest | Example |
| --- | --- | --- | --- |
| Check emails or phones as contacts arrive | Verdicts on forms, imports and new contacts; your field and tags | `extensions.contact_validate` | Emailable |
| Suggest postal addresses | Your suggestions in the address field of the contact editor, instead of OpenStreetMap | `extensions.address_lookup` | Mapbox |
| Do something during an automation | A block in the automation editor, with a form and outputs for later steps | `extensions.automation_actions` | Emailable "Verify email", Kapso "Send WhatsApp template" |
| Start automations from your service | Events in the trigger list | `extensions.automation_triggers` | Kapso "WhatsApp message received" |
| Fill choices from your service | A select whose options your app lists (templates, lists, pipelines) | `options_endpoint` on an input | Kapso template picker |
| Send form submissions somewhere | A connector next to the built-in ones in **Forms → Connections** | `extensions.form_connectors` | |
| Bring a messaging channel into the inbox | Conversations, replies, delivery state, templates when the reply window is closed | `extensions.channels` | Kapso WhatsApp |
| Show your own UI | Settings, a full page with a sidebar entry, a contact card or button, a dashboard widget | `extensions.ui` | All three |
| Store values on records | Your fields on contacts, companies, opportunities | `custom_fields` | Emailable "Email status" |
| Keep app data per record or per install | Nothing directly; exported and erased with the record | App API `entities`, `data` | Both |
| Add history to a contact | Entries in the contact timeline | App API `timeline` | |
| React to CRM changes | Nothing directly | `webhooks.events` | |

Anything else goes through the public API within the app's scopes. If an integration needs an
extension point that does not exist, open an issue describing what the user should see:
extension points are added to the current API version without breaking existing apps.

## API versions

Every manifest declares an `api_version` (`YYYY-MM`, today `2026-10`). The CRM sends it back
in every call (`api_version` in the body, `Amable-Api-Version` header) and answers your API
requests in that version. A new version ships only for breaking changes; additions (new
fields, events, scopes, extension points) arrive in the current version and your code must ignore
what it does not know. The [changelog](CHANGELOG.md) lists them.

When a version is superseded, it keeps being served for **12 months**. Installations list the
versions they serve in `/.well-known/amable-apps.json` (`api_versions`) together with the
extension points they support (`extension_points`): self-hosted installations update at their
own pace, so check them instead of assuming. `min_version` in the manifest stops installs on
releases that are too old.

## The manifest

`manifest.json` describes the app; the CRM accepts nothing that is not declared in it. The
full schema is `appManifestSchema` in
[`packages/core/src/apps/manifest.ts`](../../packages/core/src/apps/manifest.ts); `amable-app
validate` checks a file against it.

```jsonc
{
  "schema_version": 1,
  "id": "my-app",                      // 3-40 chars, a-z 0-9 -, unique in the Marketplace
  "name": "My App",
  "version": "1.0.0",                  // semver, bumped with every release; shown to admins
  "tagline": { "en": "One line", "it": "Una riga" },
  "description": { "en": "Shown on the app page (up to 500 characters)" },
  "developer": { "name": "…", "url": "https://…", "email": "…" },
  "categories": ["data_quality"],      // 1-3 of APP_CATEGORIES
  "icon_url": "https://…/icon.png",
  "homepage": "https://…", "support_url": "https://…", "privacy_url": "https://…",
  "base_url": "https://my-app.example.workers.dev",   // every endpoint path is relative to it
  "jwks_url": "https://my-app.example.workers.dev/.well-known/jwks.json",
  "redirect_uris": ["https://my-app.example.workers.dev/install"],
  "api_version": "2026-10",
  "scopes": ["contacts:read", "contacts:write"],
  "webhooks": { "endpoint": "/webhooks", "events": ["contact.created"] },
  "privacy": { "handles_personal_data": true, "erasure_endpoint": "/privacy/erasure", "data_request_endpoint": "/privacy/data" },
  "custom_fields": [{ "key": "email_status", "label": { "en": "Email status" }, "type": "TEXT" }],
  "extensions": {
    "contact_validate": { "fields": ["email"], "endpoint": "/hooks/validate", "batch_endpoint": "/hooks/validate-batch" },
    "automation_actions": [], "automation_triggers": [], "form_connectors": [], "channels": [],
    "ui": [{ "slot": "app.settings", "key": "settings", "path": "/ui/settings", "title": { "en": "Settings" } }]
  }
}
```

Rules worth knowing:

- **`base_url`** may include a path (`https://apps.example.com/my-app`): several apps can share
  one domain or one Worker. `createAppHandler` strips the path before routing (`appPath()` does
  the same for your own routes), and screens should load their files and call their API with
  relative URLs under `<base href="<base_url>/">`.
- **Official apps** (the ones in `examples/apps`) are not hosted anywhere: their catalog manifest
  has `base_url` `https://deployed-app.invalid` and a `deployment` block, and each CRM deploys
  them into its own Cloudflare account (see [Official apps](#official-apps-run-in-each-installations-cloudflare)).

- **Scopes** are the tenant permissions (`contacts:read`, `orders:write`, …) minus the ones that
  administer people, keys, apps and the workspace. `contacts:read_sensitive`,
  `data:export_full`, `data:bulk_delete` and `orders:refund` are shown with a warning and only
  the owner can grant them. Ask for the least you need: admins see the list before installing.
- **Events** need the scope that reads their data (`contact.*` needs `contacts:read`, `order.*`
  needs `orders:read`, …).
- **Extensions** need their scope: `contact_validate` and `address_lookup` need `contacts:read`, `channels` need
  `conversations:write`, `form_connectors` need `forms:submissions_read`, custom fields need
  `contacts:write`; firing triggers needs `automations:trigger`.
- **Custom fields** are created on install, prefixed `app_<id>_<key>` and owned by the app:
  only the app writes them, admins can hide them.
- Apps with a personal-data scope must set `handles_personal_data: true` and provide both
  privacy endpoints.
- Texts shown to users are localized objects (`{ "en": …, "it": … }`); `en` is required.
- A new manifest is applied to existing installs automatically, unless it asks for new scopes:
  then the admin is asked again (`app.scopes_pending`) and the app keeps working with the old
  scopes meanwhile. See [Releasing an update](#releasing-an-update).

## Install flow (OAuth)

1. The admin clicks **Install** in the Marketplace and accepts the scopes on the consent screen.
2. The browser lands on your `redirect_uri` with `code`, `installation_id`, `tenant`, `iss`
   (the installation origin) and `state`.
3. The app reads `{iss}/.well-known/amable-apps.json` (token endpoint, JWKS, versions) and
   exchanges the code at `POST {iss}/api/apps/v1/token`, authenticating with a JWT signed by its
   own key (`private_key_jwt`: `iss = sub = <app id>`, `aud` = token endpoint, `exp` at most
   5 minutes, a unique `jti`). PKCE (`S256`) is supported when the install starts from the app.
4. The answer has `access_token` (1 hour), `refresh_token` (rotated on every use), `scope`,
   `installation { id, app_id, status, api_version, tenant, origin, api_base }` and, only on the
   first exchange, `webhook_secret`. Store them per installation.

`GET /api/apps/v1/installation` returns status and scopes; `POST /api/apps/v1/revoke` revokes a
token. Uninstalling revokes everything and sends `app.uninstalled`.

The app key is your identity: publish the public part at `jwks_url` and keep the private part
in a secret (`APP_KEYS` in the template). Rotate it with `amable-app keys rotate`: the new key
signs, the old one stays published until you prune it.

An installation proves its own identity with an Ed25519 key published at
`/.well-known/amable-apps/jwks.json`; screen session tokens are signed with it.

## Calls from the CRM and their signature

Every request the CRM makes to your app (events, hooks, actions, options, connectors, channel
sends and templates, privacy) is a `POST` with a JSON body that always includes
`installation_id`, `tenant` and `api_version`, and these headers:

```text
Amable-Signature: t=1760000000,v1=<hex HMAC-SHA256 of "t.body" with the webhook secret>
Amable-Installation: ai_…
Amable-Api-Version: 2026-10
Idempotency-Key: …            (actions, connectors, sends: retries reuse it)
```

Verify the signature against the secret of that installation, reject timestamps older than
5 minutes, and answer `401` to anything unsigned (the conformance suite checks it).
`verifySignature` / `readSignedCall` in the SDK do this. During a secret rotation the CRM sends
`app.secret_rotated`: fetch the new one from `GET /api/apps/v1/webhook-secret` and accept both
for a day.

Calls with `"test": true` come from the conformance suite (`amable-app test`, the catalog CI):
check the signature and answer `2xx` without side effects (send nothing, charge nothing).

Calls that time out or fail too often open a circuit breaker for that install: the CRM stops
calling for a few minutes and goes on without you. Paused or uninstalled apps are never called.

| Call | Budget | On failure |
| --- | --- | --- |
| `contact.validate` | 1.5 s | the contact goes on without a verdict |
| `contact.validate` batch | 10 s | items without an answer get no verdict |
| Automation action | 15 s | retried on `5xx`, `408`, `425`, `429`, timeouts; other `4xx` fail the step |
| Options, channel templates | 8 s | the editor or composer shows "unavailable" |
| Channel send | 10 s | the message is marked failed with your `error` |
| Form connector | 15 s | timeouts and transient statuses are retried |
| Privacy erasure / data request | 5 s / 8 s | erasure also arrives as the `privacy.erasure_requested` event (retried); a failed data request is reported in the export |

## Events (webhooks)

Subscribed events and the lifecycle events arrive at `webhooks.endpoint`:

```json
{ "id": "evt_…", "type": "contact.created", "created_at": "2026-10-17T10:00:00Z",
  "tenant": "acme", "installation_id": "ai_…", "api_version": "2026-10", "sequence": 42,
  "data": { … } }
```

Answer `2xx` quickly; failures are retried with backoff. Delivery is at least once and not
strictly ordered: deduplicate on `id`, order with `sequence`. Missed events can be read back from
`GET /apps/events?since=<sequence>` (App API). Lifecycle events: `app.installed`,
`app.uninstalled`, `app.scopes_pending`, `app.scopes_granted`, `app.secret_rotated`.

## Contact validation hook

`contact_validate` lets the app check email and/or phone of contacts created in the CRM, from
public forms and from imports. Request:

```json
{ "hook": "contact.validate", "source": "crm|form|import", "contact_id": "c_…",
  "values": { "email": "ada@example.com", "phone": "+39…" } }
```

Answer within **1.5 seconds**:

```json
{ "valid": false, "reason": "This email address does not receive mail. Did you mean ada@gmail.com?",
  "set_fields": { "email_status": "undeliverable" }, "tags": ["Invalid email"],
  "entity_data": { "score": 12 } }
```

- `valid: null` means "don't know". Timeouts and errors never block anything (fail-open).
- With `contacts:write`, `set_fields` writes your own custom fields (with or without the
  `app_<id>_` prefix) and `tags` (up to 10) are applied by name.
- Results are cached per value for `cache_ttl_seconds` (default 7 days).
- Forms set to **blocking** validation reject the submission when you answer `valid: false`,
  showing `reason` next to the field: make reasons short, human and actionable.
- Imports call `batch_endpoint` (if declared) with `{ "items": [{ "ref", "values" }] }` (up to
  100) and expect `{ "results": [{ "ref", "valid", … }] }` within 10 seconds. Bound your
  concurrency and answer what is done before the deadline (Emailable's `mapLimited`).

## Address lookup

`address_lookup` replaces the CRM's built-in address search (OpenStreetMap through Photon) in the
address field of the contact editor. While the user types, the CRM calls `endpoint` with:

```json
{ "q": "via roma 1", "lang": "it-IT", "country": "IT" }
```

`lang` and `country` (ISO 3166-1 alpha-2, the country picked on the address) may be `null`.
Answer within **3 seconds**:

```json
{ "suggestions": [{ "line1": "Via Roma", "street_number": "1", "locality": "Milano",
  "region": "Milano", "postal_code": "20121", "country_code": "IT" }] }
```

- Only `line1` is required; `label` is optional (the CRM builds `Via Roma 1, 20121 Milano, …`).
  The CRM keeps the first 5 in `country`, without duplicates.
- Put on `region` what goes on a postal address of that country: the province in Italy and
  Spain, the state elsewhere.
- Any error or a slower answer makes the CRM use OpenStreetMap for that search, unless the
  installation turned it off (`ADDRESS_LOOKUP_URL=off`). Answer an error, not an empty list, when
  the app is not set up yet (no API key), so users keep getting suggestions.
- `attribution` (up to 120 characters) is shown under the suggestions, as most geocoders'
  terms require; without it the CRM shows the app name.
- With more than one address app, the one installed first answers. Paused apps are skipped.
- The CRM stores the address the user picks: if the provider allows keeping results only under
  some plan (Mapbox's permanent geocoding), let the admin choose it in your settings screen.

## Automation actions and triggers

Each `automation_actions` entry becomes a step in the automation editor; `input_schema` (a
flat JSON-schema subset, see `appInputSchemaSchema`) becomes its form, and strings with
`merge_tags: true` are resolved before the call. The CRM posts:

```json
{ "action": "send_template", "input": { … }, "contact_id": "c_…",
  "contact": { "id", "first_name", "last_name", "email", "phone" },
  "automation": { "id", "version_id", "node_id", "step_id" }, "idempotency_key": "…" }
```

within 15 seconds. Answer `2xx` with `{ "output": { … } }`: the keys listed in `output_keys` are
available to later steps as `{{steps.<step>.<key>}}`. `5xx`, `408`, `425`, `429` and timeouts
are retried; other `4xx` fail the step (put a short message in `error`). `contact` is present
only with `contacts:read`.

Retries reuse `idempotency_key`: an action with side effects (a message, a charge) must remember
the keys it has done and answer the same output again instead of repeating the effect (Kapso
keeps them in KV for 3 days).

`automation_triggers` declares events your app can start automations with:
`POST /apps/events { "key", "contact_id", "event_id"?, "data"? }` (needs `automations:trigger`;
`event_id` deduplicates, so pass the provider's event or message id).

## Options loaded from the app

A string input of an action or a connector setting can take its choices from the app, for lists
that only your service knows (message templates, mailing lists, pipelines of another tool):

```json
"template": { "type": "string", "title": { "en": "Template" }, "options_endpoint": "/options/templates" }
```

When the form opens, the CRM posts `{ "kind": "action|connector", "key", "property" }` to the
endpoint and expects `{ "options": [{ "value", "label", "description"? }] }` (up to 500) within
8 seconds. The editor shows a select; a saved value your app no longer lists stays visible, and
when the install is paused or the call fails the editor says so instead of losing the value.
`options_endpoint` is for string properties without `enum`. Cache the list briefly: the editor
asks every time it opens.

## Form connectors

`form_connectors` appear next to the built-in ones in **Forms → Connections**; `settings_schema`
becomes the settings form (with `options_endpoint` too). For every accepted submission the CRM
posts `{ "connector", "settings", "form", "submission", "contact", … }` (the same body as the
form webhook connector) within 15 seconds, with an idempotency key per submission and connection.
Needs `forms:submissions_read`.

## Conversation channels

`channels` add a channel to the shared inbox (Conversations), for example WhatsApp:

```json
{ "key": "whatsapp", "name": { "en": "WhatsApp" }, "kind": "whatsapp",
  "send_endpoint": "/channels/send", "address_field": "phone",
  "reply_window_hours": 24, "templates_endpoint": "/channels/templates" }
```

- **Inbound**: post each message you receive from the provider to
  `POST /apps/messages/inbound` with `{ "channel", "external_id", "from", "text", "contact"?, "sent_at"? }`.
  The CRM finds or creates the contact and the conversation; `external_id` deduplicates.
  Needs `conversations:write`.
- **Replies**: when an agent replies, the CRM posts
  `{ "channel", "conversation_id", "to", "contact", "message": { "id", "text", "template"? } }` to
  `send_endpoint` (idempotency key = message id). Answer `{ "external_id", "status": "sent" }`,
  or a `4xx` with `{ "error" }` that the agent sees on the failed message.
- **Delivery updates**: post them to `POST /apps/messages/status` with
  `{ "channel", "external_id", "status": "delivered|read|failed", "error"? }`. A `404` means the
  message was not sent through the CRM: ignore it.
- **Messages sent elsewhere**: messages your app sends outside the inbox (an automation step, the
  provider's own app on the phone) go to `POST /apps/messages/outbound` with
  `{ "channel", "external_id", "to", "text", "template"?, "status"?, "sent_at"? }` so the thread
  shows them; the CRM does not send them again, and `external_id` deduplicates
  (`messages.outbound()` in the SDK).

**Reply window and templates.** Some channels accept free text only for a while after the
contact's last message (WhatsApp: 24 hours); after that the business must send a pre-approved
template. With `reply_window_hours`, the CRM refuses free text once the window is closed and the
composer switches to templates; new conversations start with a template too. Such a channel must
declare `templates_endpoint`:

- The CRM posts `{ "channel" }` and expects, within 8 seconds,
  `{ "templates": [{ "id", "name", "language", "category", "text", "params": [{ "key", "example" }] }] }`:
  only templates that can be sent right now (approved, supported). `text` uses `{{key}}`
  placeholders for the preview; parameter keys are `A-Za-z0-9_`.
- With an empty list, add `"notice"` (up to 300 characters, in the team's language) to tell the
  team why: the composer shows it in place of "no templates" (e.g. the app is not connected yet).
- A template reply reaches `send_endpoint` as
  `"message": { "id", "text": "[<template id>]", "template": { "id", "params": { "key": "value" } } }`.
  Build the provider request from your own copy of the template, refuse missing parameters with a
  `422`, and answer `text` with the rendered body so the thread shows what the contact received.
- The window reopens when the contact writes again.

## Screens inside the CRM

`ui` entries render your pages in a sandboxed iframe:

| Slot | Where |
| --- | --- |
| `app.settings` | App settings (one per app) |
| `app.page` | A full page with an entry in the sidebar |
| `contact.sidebar` | A card on the contact page |
| `contact.actions` | A button in the contact header that opens your screen |
| `dashboard.widget` | A widget on the home dashboard |

An `app.page` is listed under **Apps** in the sidebar. Set `nav_group` (`crm`, `marketing`,
`ecommerce`, `analytics`, `reports`) to list it in that group next to the built-in modules
instead, e.g. `{ "slot": "app.page", "key": "campaigns", "nav_group": "marketing", … }`.

The CRM loads `base_url + path` with `session_token`, `host`, `locale` and `theme` in the query.
The session token is a 5-minute JWT signed by the installation (`aud` = your `base_url`) with
`app_id`, `install_id`, `tenant`, `user`, `role`, `slot`, `key` and, on contact slots,
`contact_id`. Verify it on your backend (`verifySessionToken`, issuer = an origin you have an
install from) and call the App API with that install's token: the iframe never sees OAuth tokens.

In the page, [`@amable/app-bridge`](../../packages/app-bridge) talks to the CRM:

```ts
import { createAppBridge } from '@amable/app-bridge';
const bridge = createAppBridge();
bridge.autoResize();
const token = await bridge.sessionToken();      // renewed through the CRM when it expires
bridge.toast('Saved', 'success');
bridge.openContact('c_123');
bridge.navigate('/contacts');
```

Pages must allow framing by the CRM origin (`Content-Security-Policy: frame-ancestors <host>`)
and must not rely on third-party cookies. The sandbox allows popups that escape it: to send the
admin to a provider page (an OAuth or onboarding flow), open the tab synchronously in the click
handler and set its location once your backend returns the URL, or browsers block it.

## App API

With the install's access token, under `{api_base}` (`/api/v2/t/<tenant>`), the app uses the
public API within its scopes, plus:

| Endpoint | Purpose |
| --- | --- |
| `GET/PUT/DELETE /apps/data/:key` | Key-value storage of the install (`secret: true` encrypts the value, e.g. API keys) |
| `GET/PATCH /apps/entities/:entity/:id` | The app's own data attached to a contact, company, opportunity or order |
| `POST /apps/timeline` | An entry in the contact timeline (`contact_id`, `title`, `body`, `icon`, `url`) |
| `GET /apps/events?since=` | Missed events |
| `POST /apps/events` | Fire an app trigger |
| `POST /apps/messages/inbound`, `/outbound`, `/status` | Conversation channels |

Requests are rate limited per install; `429` answers carry `Retry-After`. The SDK client
(`ctx.api` in handlers) wraps all of them.

## Privacy

Apps that handle personal data must honour erasure and access requests. When a contact is
erased, the CRM posts `{ "request_id", "contact_id", "email", "phone" }` to `erasure_endpoint`:
delete everything you hold about that person, including at the provider when you created
something there for them. For access requests it posts the same to `data_request_endpoint` and
includes your JSON answer (`{ "data": … }`) in the export it gives the contact. Uninstalling
deletes the app's data, entity data and custom field values in the CRM.

## Integrating well

Workspaces trust an app with their data and their customers. The reference apps follow these
rules; reviewers check them.

**Never get in the way.**

- Hooks fail open: when the provider is slow, down or not configured, answer `valid: null` and
  let the CRM go on. Set your own timeout under the CRM's budget and leave room for your work
  (Emailable waits 1.2 s of the 1.5 s).
- Tell transient failures from permanent ones. Provider timeouts, `429` and `5xx` become a `5xx`
  (or `429`) so the CRM retries; a wrong key, no credits, a bad input become a `4xx` with an
  `error` a user understands ("add your API key in the app settings", not "HTTP 403").
- Never throw on a test call (`"test": true`), and never cause side effects in one.

**Do things exactly once.**

- Use the idempotency key of actions, connectors and sends; deduplicate provider webhooks on the
  provider's event or message id (pass it as `external_id` or `event_id`, the CRM deduplicates
  too).
- Provider webhooks are retried and batched: process every item, answer `2xx` when done, `5xx`
  when the CRM was unreachable so the provider retries.

**Every install is a separate customer.**

- Key everything by installation id: stored values, caches, provider resources, webhook URLs
  (`/provider/webhook/<installation id>`).
- The workspace's provider credentials go in the App API data store with `secret: true`, never in
  your own storage, logs or URLs. Prefer the provider's `Authorization` header to keys in query
  strings, which end up in logs. Show only the last 4 characters in screens.
- Check a credential against the provider before saving it.
- Sign provider webhooks with a random secret per install, verify the signature on the raw body,
  and drop events for resources the install does not own.
- Delete what you created at the provider (webhooks, links) when the admin disconnects or
  uninstalls (`app.uninstalled`).

**Keep it light.**

- Cache per isolate with a short TTL what every call needs (credentials: 5 minutes, provider
  lists: 1 minute) and drop the entry when the admin changes it.
- Bound concurrency towards the provider; respect its rate limits.
- Store as little as possible about contacts. When you must (Kapso maps phone numbers to contacts
  to route opt-out events), set a TTL where you can, and cover it in both privacy endpoints.

**Make it understandable.**

- Explain in the manifest description, the settings screen and the README what the app does,
  which account it needs, what it costs (credits, messages) and what happens to the data.
- Localize every text in English and Italian; follow the CRM's `locale` and `theme` in screens.
- Errors shown to users say what to do next.
- Know the provider's sandbox: say what it cannot do (Kapso's sandbox cannot use templates) and
  degrade gracefully instead of failing.

## Tests and fixtures (required)

Providers change their APIs, and the person fixing an app in a year will not have the original
author's test account. Every app in the catalog therefore ships automated tests that run with no
network and no credentials, against **recorded answers of the real API**. A pull request without
them is not reviewed.

**Layout.**

```text
test/
  app.test.ts                   tests (vitest)
  fixtures/<provider>/*.json    one recorded request/answer per file
  fixtures/<provider>/webhooks/ provider webhook bodies, if any
scripts/record-fixtures.ts      re-records the live fixtures
```

**Fixture format** (`Fixture` in `@amable/app-sdk/testing`):

```json
{
  "provider": "emailable",
  "description": "A misspelled domain: Emailable suggests the fix",
  "source": "live",
  "recorded_at": "2026-10-18",
  "request": { "method": "GET", "url": "https://api.emailable.com/v1/verify?email=amable.fixture%40gmial.com", "match_query": true },
  "response": { "status": 200, "body": { "state": "undeliverable", "did_you_mean": "amable.fixture@gmail.com", "…": "…" } }
}
```

- `request.url` may contain `{param}` segments (`…/v24.0/{phone_number_id}/messages`); the
  query string is ignored unless `match_query` is true.
- `source: "live"` fixtures come from the real API, recorded by a script you commit. Record
  errors too: wrong key, missing key, not found, limits.
- When the real API cannot be called (production-only features, paid operations, flows that
  need a human), copy the example from the provider's reference with `source: "docs"` and the
  page in `docs_url`.
- **Redact before writing**: `redact()` masks keys, tokens and secret-like fields and replaces the
  strings you list (account emails, names). Use public or made-up addresses and numbers, never
  real people's. Read the diff before committing; credentials never go in the repository, not even
  in a test.
- Recording scripts make only harmless calls, and undo what they create (a webhook created to
  record the answer is deleted right after).

**The testing kit** (`@amable/app-sdk/testing`) runs the whole Worker in memory:

| Helper | What it does |
| --- | --- |
| `fixtureFetch(fixtures)` | A `fetch` that answers from fixtures; `use()` puts error cases first; `calls` and `unmatched` show what the app asked |
| `fakeCrm()` | The App API in memory: app data, entities, messages, events, timeline, contacts; `on()` adds or overrides routes (e.g. a `503`); `sessionToken()` signs screen tokens |
| `routeFetch(...)` | Combines them: the CRM's URLs go to `fakeCrm`, the rest to the fixtures |
| `signedCaller(...)` | Calls your endpoints as the CRM does, signed |
| `testInstall()`, `memoryKv()` | An installation and a KV store |
| `redact()` | For recording scripts |

```ts
const crm = fakeCrm();
crm.data.set('emailable_api_key', { value: 'live_test', secret: true });
const provider = fixtureFetch([verifyTypo, account].map((f) => f as Fixture));
const worker = createWorker({ fetch: routeFetch(crm.fetch, provider.fetch) });
const install = testInstall({ scopes: manifest.scopes });
await kvInstallStore(kv).put(install);
const call = signedCaller({ fetch: (r) => worker.fetch(r, env), baseUrl: manifest.base_url, install });

expect(await call('/hooks/validate', { hook: 'contact.validate', source: 'form', values: { email: 'amable.fixture@gmial.com' } }))
  .toMatchObject({ status: 200, body: { valid: false } });
expect(provider.calls[0]?.headers['authorization']).toBe('Bearer live_test');
```

**What the tests must cover**:

- every endpoint in the manifest, with the provider's success answers and its errors (wrong
  credentials, limits, timeouts), checking what the app answers the CRM;
- what the app sends to the provider (URL, headers, body) and to the CRM (`crm.inbound`,
  `crm.outbound`, `crm.statuses`, `crm.events`, `crm.data`, `crm.entities`);
- provider webhooks: signature accepted and refused, batches, every event type you handle,
  retries when the CRM is down;
- idempotency: the same action or webhook twice does one thing;
- screens' backend APIs, with a session token from `crm.sessionToken()`;
- privacy: export and erasure of what you store;
- the conformance suite (`runConformance`) against the in-memory Worker, so CI catches a broken
  endpoint before the catalog does.

When the provider changes an answer, record it again (or copy the new docs example) and let the
failing tests show what to change. The Kapso and Emailable test suites are complete examples.

## The CLI

```text
create-amable-app <dir> [--id] [--name] [--base-url]   new project from the Worker template
amable-app keys generate|rotate|prune|jwks|secret      signing keys in .amable/keys.json (never commit it)
amable-app validate [manifest.json]                    schema check
amable-app test --manifest manifest.json [--local] [--secret whsec_… --installation ai_…]
```

`test` runs the same conformance suite as the catalog CI: valid manifest, HTTPS, a JWKS with
public keys only, every endpoint refusing unsigned calls, and, with the webhook secret of a
development install, signed calls answering in time (1.5 s for `contact.validate`) and
templates and options endpoints answering with a list.

**Local development**: set `base_url` and the derived URLs to `http://localhost:8787` and install
from **Settings → Apps → Install from URL** with `http://localhost:8787/manifest.json`. Private
apps work on any installation (marked "not verified"); `http://localhost` is accepted only for
them.

## Publishing in the Marketplace

The catalog is the [amable-apps](https://github.com/Ratne/amable-apps) repository. Open a pull
request adding `apps/<id>/manifest.json`; CI validates it and runs the conformance suite against
your live `base_url`, then a maintainer reviews the scopes, the privacy policy and the app's
tests. On merge the signed index is rebuilt and installations pick it up within 6 hours. Updating
means a new pull request with the new manifest (see [Releasing an update](#releasing-an-update)). A listed app can be revoked if it misbehaves:
installations then pause it everywhere.

Checklist before opening the pull request:

- [ ] `amable-app validate` passes; the description says what the app does, which account it
      needs and what it costs, in English and Italian.
- [ ] Scopes are the minimum; `handles_personal_data` and both privacy endpoints are set if any
      scope reads personal data.
- [ ] The source is public (link it in `homepage`), with a README explaining setup and privacy.
- [ ] Tests run offline with recorded fixtures and cover the points above; the recording script
      is committed; no credential or personal data is in the repository or its history.
- [ ] `amable-app test` passes against the deployed `base_url`, including signed calls with the
      secret of a development install.
- [ ] Hooks fail open within their budget; actions and webhooks are idempotent; errors shown to
      users say what to do.
- [ ] Provider credentials live in app data with `secret: true`; provider webhooks are signed
      per install and deleted on disconnect and uninstall.
- [ ] Screens work in light and dark theme, in both languages, inside the iframe.
- [ ] `privacy_url` and `support_url` work.

## Releasing an update

An app is a service you host, not code copied into each CRM: every installation, on the Cloud
or self-hosted, calls the same `base_url`. An update therefore travels on two channels.

| What changed | How it reaches installations | When |
| --- | --- | --- |
| App code (bug fixes, better answers, new provider calls) | Your deploy | At once, everywhere |
| Manifest without new scopes (texts, endpoints, extensions, fields, events) | Catalog pull request, then each CRM's catalog sync | Within 6 hours, applied automatically |
| Manifest with new scopes | Same, then an admin approves on **Settings → Apps → Installed** | When each admin approves |
| App installed from a URL | Each CRM fetches `manifest_url` again, same rules | Within 6 hours |

**Settings → Apps → Refresh catalog** fetches the catalog and the workspace's private manifests at
once. A revoked app is paused everywhere at the next sync.

### Steps

1. Fix the code, bump `version` in the manifest (patch for fixes, minor for features, major when
   admins must act) and add the entry to the app's `CHANGELOG.md`.
2. Run the offline tests and the typecheck; add a fixture for the provider answer the fix is
   about.
3. Deploy, then run `amable-app test --manifest manifest.json` against production. The code is
   live for every installation from this moment.
4. If the manifest changed beyond `version`, open the catalog pull request with it. Bumping
   `version` alone is also worth a pull request, so admins see the release they run.
5. New scopes wait for each admin: until then the app gets `app.scopes_pending` and works with the
   old ones. On approval it gets `app.scopes_granted`.
6. Something broke: roll the deploy back (`wrangler rollback`), and open a catalog pull request
   with the previous manifest if that changed too.

### Staying compatible

- **The code runs ahead of the manifest.** For hours (catalog sync) or days (scopes not yet
  approved) some installations still run the previous manifest against your new code. Keep
  serving every endpoint the previous manifest declares, and check the granted scopes
  (`Amable-Granted-Scopes`) before using a new one.
- **Self-hosted CRMs update at their own pace.** A manifest using a field or extension point their
  release does not know is rejected by their catalog sync: the app disappears from their
  Marketplace and existing installs keep the previous manifest. Check `extension_points` in
  `/.well-known/amable-apps.json`, and set `min_version` when the app cannot work on older
  releases.
- **Official apps are released, not deployed**: a new bundle reaches an installation only through
  the catalog (see below), so `main` can move freely.

## Official apps run in each installation's Cloudflare

The official apps never run on AmableData's Cloudflare account: no Worker, database, secret or
deploy step of theirs may ever point at it. Each installation runs its own copy, in its own
Cloudflare account, and pays nothing to us for it:

1. The catalog manifest declares the resources (`deployment`: one module Worker, its D1
   databases, cron triggers) and the released bundle (`bundle_url`, a GitHub release asset of
   this repository, and `bundle_sha256`). `base_url`, `jwks_url` and `redirect_uris` use the
   placeholder origin `https://deployed-app.invalid`.
2. On **Install**, the CRM downloads the bundle, checks its SHA-256 against the signed catalog and
   deploys it as `amable-app-<id>` with the D1 database `amable-app-<id>-db` and the
   `APP_BASE_URL` variable set to its `workers.dev` address. The installed manifest is the catalog
   one with the placeholder replaced by that address; then the usual consent and OAuth follow.
   - **AmableData Cloud**: the control plane deploys with the Cloudflare token saved during the
     portal setup (`POST /v1/installation/apps/deploy`). If the customer deleted the token, the
     install answers `cloudflare_token_inactive` and the portal asks for a new one.
   - **Self-hosted**: the first time, an owner creates a token with Workers Scripts and D1
     (Edit) from the prefilled link, picks the account, and the CRM keeps it encrypted
     (**Settings → Apps → Installed → Cloudflare account for the apps**).
3. The app creates its tables and its signing key in its own D1 on the first request
   (`appKeysLoader`, `d1InstallStore`, `d1KeyValue` of `@amable/app-sdk`): nothing to configure.
4. A catalog update with a new `bundle_sha256` redeploys the copy before the manifest is applied;
   when the deploy fails, the previous version keeps running and the admins are notified.
5. When no workspace of the installation uses the app any more, the Worker and its database are
   deleted from the account by the periodic cleanup, at least one hour after the last uninstall.

Releasing an official app: bump `version` in its manifest, run its tests, then
`node scripts/release-app.mjs <id> --publish`. The script builds `dist/worker.mjs`
(`scripts/bundle-app.mjs`, screens inlined), attaches it to the release `app-<id>-v<version>` and
writes the catalog manifest (with the SHA-256) and the icon into the amable-apps checkout, for the
catalog pull request. A published version is immutable.

Apps of other developers keep the hosted model of the sections above: they run on the developer's
infrastructure, at the developer's cost.
