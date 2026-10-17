# WATI for AmableData

Reference app (MIT): WhatsApp through the workspace's own [WATI](https://www.wati.io) account.
It shows a conversation channel, an automation action, an automation trigger, a settings screen
that stores credentials encrypted in the installation's app data, and how to receive webhooks
from a provider that does not sign them.

- **Channel `whatsapp`**: messages received in WATI land in Conversations (the contact is found
  by phone number or created); replies from the CRM go out with `sendSessionMessage`; delivered,
  read and failed updates come back on the message. WhatsApp accepts free text only within 24 h
  of the contact's last message: outside that window WATI refuses it and the agent sees why.
- **Action "Send WhatsApp template"**: an approved template, with `name=value` parameters that
  can use merge tags. It returns `message_id` for later steps.
- **Trigger "WhatsApp received"**: starts automations when a contact writes; the text is in the
  event data.

## Webhook from WATI

WATI webhooks carry no signature. The settings screen shows a per-installation URL,
`/wati/webhook/<installation id>/<random token>`; requests with a wrong token get a 404. Paste it
in WATI → Webhooks with the message received, delivered, read and failed events.

## Run your own copy

```sh
npx amable-app keys generate                             # in this folder; writes .amable/keys.json
npx amable-app keys secret | npx wrangler secret put APP_KEYS
npx wrangler kv namespace create INSTALLS                # put the id in wrangler.jsonc
pnpm --filter @amable/example-app-wati deploy
```

Change `base_url`, `jwks_url`, `redirect_uris` and the route in `wrangler.jsonc` to your domain,
then install it from **Settings → Apps → Install from URL** with `<base_url>/manifest.json`.

## Privacy

The app keeps no messages or contacts: they live in the CRM and at WATI. The Worker stores the
OAuth tokens of each installation and the webhook token; the WATI credentials are encrypted by the
CRM and readable only by this app's installation. Uninstalling deletes them.
