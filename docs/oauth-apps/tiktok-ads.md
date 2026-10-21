# TikTok app (ads)

One TikTok for Business developer app lets users connect their advertiser accounts to
import spend and send server-side events (Events API), deduplicated with the browser
pixel through `event_id`.

On the managed offering (`LICENSE_KEY` set) TikTok is **brokered by the control plane**,
like Meta: one central app registered against the control plane host, no app or secrets
on installations (see [Central app](#central-app-managed-cloud)). An own app
(`TIKTOK_APP_ID` + `TIKTOK_APP_SECRET`), when configured, always takes precedence.

## 1. Create the app

1. You need a [TikTok for Business](https://business.tiktok.com) account (the same login
   used for Ads Manager).
2. Go to the [TikTok for Business developer portal](https://business-api.tiktok.com/portal)
   and register as a developer (company details; a one-time review).
3. *My apps → Create an app*:
   - app name and description of the use case (ads reporting and conversion upload for a
     CRM);
   - **Advertiser redirect URL**:

     ```text
     https://<your dashboard host>/oauth/ads/callback
     ```

   - scopes: **Ad Account Management** (read), **Reporting**, and **Events API** /
     measurement.
4. Submit the app for review. TikTok approves apps manually; typical turnaround is a few
   business days. Until approval the app works in **sandbox mode** only (sandbox ad
   accounts, no real data).
5. Note the **App ID** and **Secret** from the app detail page.

## 2. Configure AmableData

```sh
cd apps/core
wrangler secret put TIKTOK_APP_ID
wrangler secret put TIKTOK_APP_SECRET
```

The TikTok card in *Analytics → Settings → Ad accounts* becomes available after deploy.

## Central app (managed cloud)

Create the app as in [section 1](#1-create-the-app), but with the **control plane** as
advertiser redirect URL:

```text
https://<control plane host>/v1/oauth/callback/tiktok
```

Secrets on the control plane worker:

```sh
cd control-plane
wrangler secret put TIKTOK_OAUTH_CLIENT_ID      # App ID
wrangler secret put TIKTOK_OAUTH_CLIENT_SECRET  # Secret
```

Scopes are configured on the app, not requested per authorization. TikTok returns the
authorized advertiser ids with the token; listing them again (`oauth2/advertiser/get/`)
needs the app secret, so the control plane stores them and hands them to the
installation on `finish`. Revoking a connection calls `oauth2/revoke_token/`.

## 3. Conversions (Events API)

- Events are sent to the pixel configured on the connection (`pixel_code` or
  `event_source_id` in the connection metadata) with `event_source: web`, the `ttclid`
  click ID when present, and hashed identifiers only.
- `test_event_code` on the connection routes events to *Events Manager → Test events*.

## Operational notes

- Access tokens are long-lived and refreshed server-side; a revoked grant shows as
  **auth expired** on the connection.
- Spend is read per campaign, ad group and ad from the reporting endpoint
  (`advertiser.get` resolves the accounts the user may pick at connect time).
- TikTok enforces per-app QPS limits; the sync cadence and the outbound queue backoff
  stay well under the default tier.
