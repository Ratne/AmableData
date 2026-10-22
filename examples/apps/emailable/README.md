# Emailable for AmableData

Reference app (MIT): verifies the email of every new contact with the workspace's own
[Emailable](https://emailable.com) account. It shows the contact validation hook, the batch
variant used by imports, an automation action, an app-owned custom field, tags, and a settings
screen that stores an API key encrypted in the installation's app data.

## What Emailable does

Emailable tells whether an email address really receives mail without sending anything to it: it
checks the syntax, the domain and its mail servers, then asks the server whether the mailbox
exists. It also flags disposable services, role addresses (`info@`, `support@`), catch-all
domains and full mailboxes, scores the address from 0 to 100 and suggests the fix of a misspelled
domain (`mario@gmial.com` → `mario@gmail.com`). Each verification uses one credit of the
workspace's Emailable account.

Bounced emails hurt the sender's reputation, so a CRM wants to know before the first campaign
whether an address works, ideally while the contact is still on the form and can fix a typo.

| Emailable state                       | `valid` | Email status  | Tags          |
| ------------------------------------- | ------- | ------------- | ------------- |
| `deliverable`                         | `true`  | deliverable   |               |
| `undeliverable`                       | `false` | undeliverable | Invalid email |
| `risky`                               | `null`  | risky         | Risky email   |
| `unknown`                             | `null`  | unknown       |               |
| no answer within 1.2 s, or no API key | `null`  | unchanged     |               |

Disposable addresses also get **Disposable email**. Score, reason and the suggested fix go to the
app's entity data on the contact. Forms set to blocking validation reject undeliverable
addresses and show the suggested fix; everything else never blocks.

In automations, the **Verify email** block verifies the contact's email (or the address typed in
the step, merge tags included) and returns `state`, `score`, `reason`, `did_you_mean` and
`disposable` to the next steps, for example to branch on `state` before sending a campaign. It
waits up to 10 seconds; when Emailable is still working or rate-limited the CRM retries the step
later, while a wrong key or no credits fail it with Emailable's message.

## Tests

`pnpm test` (from the repo root: `pnpm vitest run examples/apps/emailable`) replays the
Emailable answers in `test/fixtures/emailable/` against the app and an in-memory CRM, with no
network. `"source": "live"` fixtures were recorded with `pnpm record-fixtures` (a few credits;
public or made-up addresses; key and account email redacted); the others are the examples of
Emailable's API reference, linked in `docs_url`.

## Hosting

The app never runs on AmableData's Cloudflare account. When a workspace installs it from the
Marketplace, the CRM deploys its bundle into the installation's **own** Cloudflare account: the
Worker `amable-app-emailable` on its `workers.dev` address and the D1 database `amable-app-emailable-db`.
On AmableData Cloud the token saved in the portal during setup is used; on a self-hosted
installation an owner connects a token (Workers Scripts and D1, Edit) the first time. Uninstalling
deletes the Worker and the database.

There is nothing to configure: on the first request the app creates its tables and its Ed25519
signing key in its database (`amable_app_keys`, one row written with `INSERT OR IGNORE`, so
isolates starting together end up with the same key).

```sh
pnpm --filter @amable/example-app-emailable dev                  # local Worker with a local D1 (wrangler.jsonc)
node scripts/release-app.mjs emailable --publish   # maintainers, from the repo root, after bumping "version"
```

The release script builds `dist/worker.mjs` (screens inlined), attaches it to the GitHub release
`app-emailable-v<version>` and writes the catalog manifest with its SHA-256 into the
[amable-apps](https://github.com/Ratne/amable-apps) checkout next to this repository.

## Privacy

The app stores no data about contacts. Emails are sent to Emailable only to verify them, with the
workspace's API key, under Emailable's own terms. The key is encrypted by the CRM and readable
only by this app's installation; removing it from the settings screen or uninstalling the app
deletes it.
