# Emailable for AmableData

Reference app (MIT): verifies the email of every new contact with the workspace's own
[Emailable](https://emailable.com) account. It shows the contact validation hook, the batch
variant used by imports, an app-owned custom field, tags, and a settings screen that stores an
API key encrypted in the installation's app data.

| Emailable state | `valid` | Email status | Tags |
| --- | --- | --- | --- |
| `deliverable` | `true` | deliverable | |
| `undeliverable` | `false` | undeliverable | Invalid email |
| `risky` | `null` | risky | Risky email |
| `unknown` | `null` | unknown | |
| no answer within 1.2 s, or no API key | `null` | unchanged | |

Disposable addresses also get **Disposable email**. Score and reason go to the app's entity data
on the contact. Forms set to blocking validation reject undeliverable addresses; everything else
never blocks.

## Run your own copy

```sh
pnpm --filter @amable/example-app-emailable dev          # from the repo root
npx amable-app keys generate                             # in this folder; writes .amable/keys.json
npx amable-app keys secret | npx wrangler secret put APP_KEYS
npx wrangler kv namespace create INSTALLS                # put the id in wrangler.jsonc
pnpm --filter @amable/example-app-emailable deploy
```

Change `base_url`, `jwks_url`, `redirect_uris` and the route in `wrangler.jsonc` to your domain,
then install it from **Settings → Apps → Install from URL** with `<base_url>/manifest.json`.

## Privacy

The app stores no data about contacts. Emails are sent to Emailable only to verify them, with the
workspace's API key, under Emailable's own terms. The key is encrypted by the CRM and readable
only by this app's installation; removing it from the settings screen or uninstalling the app
deletes it.
