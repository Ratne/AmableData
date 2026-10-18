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

The official copy runs at `https://apps.amabledata.com/emailable` inside the
[apps host](../host), one Worker for every official app.

To run your own copy on its own Worker:

```sh
pnpm --filter @amable/example-app-emailable dev   # from the repo root
npx amable-app keys generate                             # in this folder; writes .amable/keys.json
npx amable-app keys secret | npx wrangler secret put APP_KEYS
npx wrangler kv namespace create INSTALLS                # put the id in wrangler.jsonc
pnpm --filter @amable/example-app-emailable run deploy
```

Change `base_url`, `jwks_url`, `redirect_uris` and `icon_url` to your Worker's URL (a path such as
`https://example.com/emailable` works too), then install it from **Settings → Apps → Install from
URL** with `<base_url>/manifest.json`.

## Privacy

The app stores no data about contacts. Emails are sent to Emailable only to verify them, with the
workspace's API key, under Emailable's own terms. The key is encrypted by the CRM and readable
only by this app's installation; removing it from the settings screen or uninstalling the app
deletes it.
