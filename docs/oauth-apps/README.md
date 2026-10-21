# Third-party OAuth apps

Some features let a workspace user connect an external account with OAuth: ad platforms
(spend import and server-side conversions) and Google (calendar bookings). The OAuth
**apps** those flows run through belong to whoever operates the installation:

- **Managed cloud** — Google (calendar), Meta and TikTok (ads) run through the **central broker
  of the control plane**: one app per platform, registered once against the control
  plane host; installations need no secrets and customers only click "Connect". The
  other platforms still take one app whose secrets go on every installation.
- **Self-hosted** — you create your own apps, once per installation (or shared across your
  installations), and you are the party the platforms verify.

Each guide below walks through creating the app, wiring it into AmableData, and the
platform's review process:

| Guide | Unlocks | Secrets (core worker) | Callback URL |
| --- | --- | --- | --- |
| [Meta ads](meta-ads.md) | Spend import, Conversions API | `META_APP_ID`, `META_APP_SECRET` (own app; the managed cloud brokers it centrally instead) | `<APP_ORIGIN>/oauth/ads/callback` (central app: `<control plane>/v1/oauth/callback/meta`) |
| [Google Ads](google-ads.md) | Spend import, click conversions | `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_DEVELOPER_TOKEN`, optional `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | `<APP_ORIGIN>/oauth/ads/callback` |
| [TikTok ads](tiktok-ads.md) | Spend import, Events API | `TIKTOK_APP_ID`, `TIKTOK_APP_SECRET` (own app; the managed cloud brokers it centrally instead) | `<APP_ORIGIN>/oauth/ads/callback` (central app: `<control plane>/v1/oauth/callback/tiktok`) |
| [Google Calendar](google-calendar-sheets.md) | Booking calendars | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | `<APP_ORIGIN>/oauth/google/callback` |

## How configuration works

- Secrets go on the **core** worker (`apps/core`):

  ```sh
  cd apps/core
  wrangler secret put META_APP_SECRET        # repeat for each secret
  ```

  or Cloudflare dashboard → the core Worker → *Settings → Variables and secrets*. IDs
  that are not secret (`META_APP_ID`, `GOOGLE_ADS_CLIENT_ID`, …) may also live in the
  `vars` block of `apps/core/wrangler.jsonc`.
- A platform **without credentials simply shows as unavailable** in the UI; nothing else
  breaks. You can configure platforms one at a time.
- In development (`ENVIRONMENT=dev`) every provider is replaced by a deterministic fake:
  no apps, no credentials, no network. The "Connect" buttons complete instantly.
- Redirect URIs must match **exactly** (scheme, host, path). `APP_ORIGIN` is the public
  origin of the dashboard. The ads callback can be overridden with
  `ADS_OAUTH_REDIRECT_URI`; the Google one is fixed at `/oauth/google/callback`.
- The OAuth callback must return to the **same origin that started the flow** (the
  pending connection is kept in the user's browser session). Fleet operators register one
  redirect URI per installation origin on each own app; brokered platforms need only the
  control plane's fixed callback, whatever the fleet size.

## What is stored, and where

- Ad platform tokens stay server-side in the installation; the browser never sees them.
  Google Calendar grants are encrypted with the installation key
  (`AUTH_ENCRYPTION_KEY`) before being stored.
- Conversion payloads sent to ad platforms carry identifiers only as SHA-256 hashes;
  plaintext email or phone is never sent or persisted. See
  [analytics-tracking.md](../analytics-tracking.md).
- Disconnecting an account deletes the stored grant; platforms also list the app under
  the user's account permissions, where access can be revoked.

## Related credentials that are not OAuth apps

| Credential | Feature | Where it is documented |
| --- | --- | --- |
| `CF_ZONE_ID`, `CF_API_TOKEN` (*SSL and Certificates: Edit*), `TRACKING_CNAME_TARGET` | Custom tracking domains (Cloudflare for SaaS custom hostnames on the zone serving the edge worker) | comments in `apps/core/wrangler.jsonc` |
| `SYSTEM_EMAIL` binding + `SYSTEM_EMAIL_FROM` | Transactional system email | top-level README |
| `LICENSE_KEY` | Managed offering: control-plane services (brokered Google + Meta / TikTok ads OAuth, notify email, wallet) | top-level README |

The legacy analytics integrations tab (organic search stats) is available only in dev
(fake data) or through the managed control plane; it has no self-hosted app yet.
