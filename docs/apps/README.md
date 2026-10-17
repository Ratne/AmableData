# Building apps for AmableData

An app extends AmableData from the outside: it is a web service you host (a Cloudflare Worker
is the easiest choice) that a workspace installs from the Marketplace, or from a URL while you
develop it. The app gets an OAuth token limited to the scopes the admin accepted, receives
events, answers hooks the CRM calls during its work, and can show screens inside the CRM.

```sh
npx create-amable-app my-app
cd my-app && npm install && npm run dev
```

The generated project ([template](../../packages/app-cli/template)) already does everything
described under "Plumbing" with [`@amable/app-sdk`](../../packages/app-sdk): you write only the
app logic. Reference apps: [Emailable](../../examples/apps/emailable) (validation hook, batch,
settings screen) and [WATI](../../examples/apps/wati) (WhatsApp channel for Conversations).

## Contents

1. [API versions](#api-versions)
2. [The manifest](#the-manifest)
3. [Install flow (OAuth)](#install-flow-oauth)
4. [Calls from the CRM and their signature](#calls-from-the-crm-and-their-signature)
5. [Events (webhooks)](#events-webhooks)
6. [Contact validation hook](#contact-validation-hook)
7. [Automation actions and triggers](#automation-actions-and-triggers)
8. [Form connectors](#form-connectors)
9. [Conversation channels](#conversation-channels)
10. [Screens inside the CRM](#screens-inside-the-crm)
11. [App API: data, entities, timeline](#app-api)
12. [Privacy](#privacy)
13. [The CLI](#the-cli)
14. [Publishing in the Marketplace](#publishing-in-the-marketplace)

## API versions

Every manifest declares an `api_version` (`YYYY-MM`, today `2026-10`). The CRM sends it back
in every call (`api_version` in the body, `Amable-Api-Version` header) and answers your API
requests in that version. A new version ships only for breaking changes; additions (new
fields, events, scopes) arrive in the current version and your code must ignore what it does
not know.

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
  "tagline": { "en": "One line", "it": "Una riga" },
  "description": { "en": "Shown on the app page" },
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

- **Scopes** are the tenant permissions (`contacts:read`, `orders:write`, …) minus the ones that
  administer people, keys, apps and the workspace. `contacts:read_sensitive`,
  `data:export_full`, `data:bulk_delete` and `orders:refund` are shown with a warning and only
  the owner can grant them. Ask for the least you need: admins see the list before installing.
- **Events** need the scope that reads their data (`contact.*` needs `contacts:read`, `order.*`
  needs `orders:read`, …).
- **Custom fields** are created on install, prefixed `app_<id>_<key>` and owned by the app:
  only the app writes them (needs `contacts:write`), admins can hide them.
- Apps with a personal-data scope must set `handles_personal_data: true` and provide both
  privacy endpoints.
- Changing scopes or extensions in a new version of the manifest makes existing installs ask
  the admin again (`app.scopes_pending`); the app keeps working with the old scopes meanwhile.

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

Every request the CRM makes to your app (events, hooks, actions, connectors, channel sends,
privacy) is a `POST` with a JSON body that always includes `installation_id`, `tenant` and
`api_version`, and these headers:

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
{ "valid": false, "reason": "mailbox does not exist",
  "set_fields": { "email_status": "undeliverable" }, "tags": ["Invalid email"],
  "entity_data": { "score": 12 } }
```

- `valid: null` means "don't know". Timeouts and errors never block anything (fail-open).
- With `contacts:write`, `set_fields` writes your own custom fields (with or without the
  `app_<id>_` prefix) and `tags` (up to 10) are applied by name.
- Results are cached per value for `cache_ttl_seconds` (default 7 days).
- Forms set to **blocking** validation reject the submission when you answer `valid: false`,
  showing `reason` next to the field: make reasons short and human.
- Imports call `batch_endpoint` (if declared) with `{ "items": [{ "ref", "values" }] }` (up to
  100) and expect `{ "results": [{ "ref", "valid", … }] }` within 10 seconds.

## Automation actions and triggers

Each `automation_actions` entry becomes a step in the automation editor; `input_schema` (a
flat JSON-schema subset, see `appInputSchemaSchema`) becomes its form, and strings with
`merge_tags: true` are resolved before the call. The CRM posts:

```json
{ "action": "send_sms", "input": { … }, "contact_id": "c_…", "contact": { … },
  "automation": { "id", "version_id", "node_id", "step_id" }, "idempotency_key": "…" }
```

within 15 seconds. `2xx` is success; the keys listed in `output_keys` are available to later
steps as `{{steps.<step>.<key>}}`. `5xx`, `408`, `425`, `429` and timeouts are retried; other
`4xx` fail the step (put a short message in `error`). `contact` is present only with
`contacts:read`.

`automation_triggers` declares events your app can start automations with:
`POST /apps/events { "key", "contact_id", "event_id"?, "data"? }` (needs `automations:trigger`;
`event_id` deduplicates).

## Form connectors

`form_connectors` appear next to the built-in ones in **Forms → Connections**; `settings_schema`
becomes the settings form. For every accepted submission the CRM posts
`{ "connector", "settings", "form", "submission", "contact", … }` (the same body as the form
webhook connector) within 15 seconds, with an idempotency key per submission and connection.
Needs `forms:submissions_read`.

## Conversation channels

`channels` add a channel to the shared inbox (Conversations), for example WhatsApp:

```json
{ "key": "whatsapp", "name": { "en": "WhatsApp" }, "kind": "whatsapp",
  "send_endpoint": "/channels/send", "address_field": "phone" }
```

- **Inbound**: post each message you receive from the provider to
  `POST /apps/messages/inbound` with `{ "channel", "external_id", "from", "text", "contact"?, "sent_at"? }`.
  The CRM finds or creates the contact and the conversation; `external_id` deduplicates.
  Needs `conversations:write`.
- **Outbound**: when an agent replies, the CRM posts
  `{ "channel", "message": { "id", "text" }, "conversation_id", "to", "contact" }` to
  `send_endpoint`. Answer `{ "external_id", "status": "sent" }`; later delivery updates go to
  `POST /apps/messages/status` with `{ "external_id", "status": "delivered|read|failed", "error"? }`.

## Screens inside the CRM

`ui` entries render your pages in a sandboxed iframe:

| Slot | Where |
| --- | --- |
| `app.settings` | App settings (one per app) |
| `app.page` | A full page with an entry in the sidebar |
| `contact.sidebar` | A card on the contact page |
| `contact.actions` | A button in the contact header that opens your screen |
| `dashboard.widget` | A widget on the home dashboard |

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
and must not rely on third-party cookies.

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

Requests are rate limited per install; `429` answers carry `Retry-After`.

## Privacy

Apps that handle personal data must honour erasure and access requests. When a contact is
erased, the CRM posts `{ "request_id", "contact_id", "email", "phone" }` to `erasure_endpoint`:
delete everything you hold about that person. For access requests it posts the same to
`data_request_endpoint` and includes your JSON answer (`{ "data": … }`) in the export it gives the
contact. Uninstalling deletes the app's data, entity data and custom field values in the CRM.

## The CLI

```text
create-amable-app <dir> [--id] [--name] [--base-url]   new project from the Worker template
amable-app keys generate|rotate|prune|jwks|secret      signing keys in .amable/keys.json (never commit it)
amable-app validate [manifest.json]                    schema check
amable-app test --manifest manifest.json [--local] [--secret whsec_… --installation ai_…]
```

`test` runs the same conformance suite as the catalog CI: valid manifest, HTTPS, a JWKS with
public keys only, every endpoint refusing unsigned calls, and, with the webhook secret of a
development install, signed calls answering in time (1.5 s for `contact.validate`).

**Local development**: set `base_url` and the derived URLs to `http://localhost:8787` and install
from **Settings → Apps → Install from URL** with `http://localhost:8787/manifest.json`. Private
apps work on any installation (marked "not verified"); `http://localhost` is accepted only for
them.

## Publishing in the Marketplace

The catalog is the [amable-apps](https://github.com/Ratne/amable-apps) repository. Open a pull
request adding `apps/<id>/manifest.json`; CI validates it and runs the conformance suite against
your live `base_url`, then a maintainer reviews the scopes and the privacy policy. On merge the
signed index is rebuilt and installations pick it up within a day. Updating means a new pull
request with the new manifest. A listed app can be revoked if it misbehaves: installations then
pause it everywhere.
