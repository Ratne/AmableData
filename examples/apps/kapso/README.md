# Kapso WhatsApp for AmableData

Reference app (MIT): connects the team's WhatsApp number through [Kapso](https://kapso.ai) and
turns it into a channel of the CRM. It shows a messaging channel with a reply window and
templates, an automation action with options loaded from the app, triggers fired by provider
webhooks, a full app page and a settings screen.

What the team gets:

- **Shared inbox.** WhatsApp messages land in **Conversations** like email; anyone on the team
  replies from there, and delivery, read and failure updates show on each message. Replies typed
  in the WhatsApp Business app on the phone (coexistence) show up too.
- **24-hour rule.** Meta accepts free text only within 24 hours of the contact's last message.
  After that the composer switches to templates: pick an approved one, fill its parameters, and
  the chat reopens when the contact answers. New conversations start with a template as well.
- **WhatsApp templates page.** Lists the templates of the number with their review state (and the
  reason, when Meta rejects one), submits new ones in any language and category (marketing,
  utility, authentication) with header, footer, buttons and examples, translates an existing one
  and deletes those no longer used.
- **Automations.** The **Send WhatsApp template** block sends the chosen template to the
  contact's phone, with parameters filled from merge tags (`first_name={{contact.first_name}}`, one
  per line); the message is recorded in the contact's conversation. The **WhatsApp message
  received** event starts flows on inbound messages; **WhatsApp marketing stopped** and
  **resumed** follow the contact's marketing preference.

## Connect a number

1. Create a project on [app.kapso.ai](https://app.kapso.ai) and an API key (**Project → API
   keys**).
2. In the CRM open **Settings → Apps → Kapso WhatsApp → Settings**, paste the key and save. The
   app checks it against Kapso and lists the numbers already in the project.
3. Choose a number, or **Connect a new number**: a Kapso setup page opens in a new tab, where the
   admin logs in with Facebook and picks or verifies the number (a new one, or the WhatsApp
   Business app already in use, kept working in parallel). When it ends, the tab returns to the
   app, which connects the number.

Connecting a number creates a Kapso webhook pointing to this app, signed with a secret that only
this installation knows; changing number, removing the key or uninstalling the app deletes it.
Kapso's sandbox number works for trying the inbox, but Meta templates need a real number.

## Tests

`pnpm test` (from the repo root: `pnpm vitest run examples/apps/kapso`) runs the app against
recorded Kapso responses in `test/fixtures/kapso/` and an in-memory CRM, with no network. The
fixtures with `"source": "live"` were recorded from a test project by `pnpm record-fixtures`
(read-only calls; keys, tokens and personal data redacted); the others come from Kapso's API
reference and webhook docs, linked in `docs_url`, for calls a sandbox cannot make. When Kapso
changes an answer, record or copy it again and let the tests show what broke.

## Hosting

The app never runs on AmableData's Cloudflare account. When a workspace installs it from the
Marketplace, the CRM deploys its bundle into the installation's **own** Cloudflare account: the
Worker `amable-app-kapso` on its `workers.dev` address and the D1 database `amable-app-kapso-db`.
On AmableData Cloud the token saved in the portal during setup is used; on a self-hosted
installation an owner connects a token (Workers Scripts and D1, Edit) the first time. Uninstalling
deletes the Worker and the database.

There is nothing to configure: on the first request the app creates its tables and its Ed25519
signing key in its database (`amable_app_keys`, one row written with `INSERT OR IGNORE`, so
isolates starting together end up with the same key).

```sh
pnpm --filter @amable/example-app-kapso dev                  # local Worker with a local D1 (wrangler.jsonc)
node scripts/release-app.mjs kapso --publish   # maintainers, from the repo root, after bumping "version"
```

The release script builds `dist/worker.mjs` (screens inlined), attaches it to the GitHub release
`app-kapso-v<version>` and writes the catalog manifest with its SHA-256 into the
[amable-apps](https://github.com/Ratne/amable-apps) checkout next to this repository.

## Privacy

Messages go through Kapso and Meta under their own terms, with the workspace's Kapso project. The
CRM keeps the conversations; the app keeps only the Kapso API key and the webhook secret
(encrypted by the CRM, readable only by this installation), the connected number, and a map
between contacts and their WhatsApp numbers used to route opt-out events. A privacy erasure
request deletes the contact from Kapso and removes it from the map; a data request returns the
number the app holds. Uninstalling the app deletes its webhook at Kapso; the CRM deletes the app
data.
