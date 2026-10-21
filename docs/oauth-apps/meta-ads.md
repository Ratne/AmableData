# Meta app (ads)

One Meta app lets workspace users connect their ad accounts to:

- import campaign / ad set / ad structure and daily spend (Marketing API);
- send server-side conversions to a pixel / dataset (Conversions API), deduplicated with
  the browser pixel through `event_id`.

Requested scopes (`META_DEFAULT_SCOPES` in `packages/ads-providers/src/meta.ts`):
`ads_read`, `ads_management`, `business_management`, plus `pages_show_list` and
`pages_read_engagement`, which app review requires alongside `ads_management`.

On the managed offering (`LICENSE_KEY` set) Meta is **brokered by the control plane**:
the operator registers one central app on the control plane host and installations need
no app, no secrets and no redirect URI of their own (see
[Central app](#central-app-managed-cloud)). An own app (`META_APP_ID` +
`META_APP_SECRET`), when configured, always takes precedence. Google Ads and TikTok stay
own-app only: Google Ads needs a per-operator developer token on every API call and
TikTok has no central upstream. Dev (`ENVIRONMENT=dev`) uses a fake client, no app
needed.

## Central app (managed cloud)

Create the app as in [section 1](#1-create-the-app) — same type, products and review
path — but register it against the **control plane**, not an installation:

- *Facebook Login for Business → Settings → Valid OAuth Redirect URIs*:

  ```text
  https://<control plane host>/v1/oauth/callback/meta
  ```

- *Facebook Login for Business → Settings*: leave the deauthorize and data deletion
  fields pointing at the control plane, which implements both callbacks
  (`signed_request` verified with the app secret, tokens dropped / rows erased plus a
  public status page):

  ```text
  https://<control plane host>/v1/oauth/meta/deauthorize
  https://<control plane host>/v1/oauth/meta/data-deletion
  ```

- *App settings → Advanced*: keep **Require app secret proof for server API calls OFF**
  — installations call the Graph API with short-lived brokered tokens and never hold the
  app secret, so they cannot compute the proof.

Secrets on the control plane worker:

```sh
cd control-plane
wrangler secret put META_OAUTH_CLIENT_ID
wrangler secret put META_OAUTH_CLIENT_SECRET
```

The Meta card then appears in every licensed installation. Tokens live encrypted on the
control plane; an installation only receives short-lived access tokens of its own
connected accounts and caches them in its sealed grant store. Disconnecting an account
revokes the authorization centrally; a user removing the app from their Meta settings
triggers the deauthorize callback and the next sync shows **auth expired**.

## 1. Create the app

1. You need a Facebook account and a [Business Portfolio](https://business.facebook.com)
   (create one if needed — app review later requires **business verification**).
2. Go to [developers.facebook.com](https://developers.facebook.com) → *My Apps* →
   *Create app*. Pick the **Business** app type and attach your business portfolio.
3. On the app dashboard, add two products:
   - **Facebook Login for Business** — under *Settings*, add the redirect URI to
     *Valid OAuth Redirect URIs*:

     ```text
     https://<your dashboard host>/oauth/ads/callback
     ```

   - **Marketing API**.
4. *App settings → Basic*: note the **App ID** and **App secret**. Fill in privacy policy
   URL, data deletion instructions URL, app icon and category — all required before the
   app can go live.

## 2. Configure AmableData (own app)

Only needed for a self-hosted installation (or to override the central broker with an
own app):

```sh
cd apps/core
wrangler secret put META_APP_ID
wrangler secret put META_APP_SECRET
```

Redeploy (or save the secrets in the dashboard). The Meta card in
*Analytics → Settings → Ad accounts* becomes available immediately.

## 3. Test before review

While the app is in **Development mode**, the OAuth flow works for people who hold a role
on the app (*App roles → Roles*: admins, developers, testers) against assets they can
access. That is enough to connect your own ad account end to end: spend sync, reports and
outbound conversions with a `test_event_code` (set it on the connection; events then show
up in Events Manager → Test events without affecting ad delivery).

## 4. App review (to let customers connect)

To let **any** Meta user connect, switch the app to Live and request **Advanced Access**
for `ads_read`, `ads_management` and `business_management` (*App review → Permissions and
features*). Meta asks for:

- completed **business verification** of the portfolio that owns the app;
- a screen recording of the OAuth flow showing why each permission is needed (connect an
  ad account → spend appears in reports → a conversion is sent);
- working privacy policy and data deletion URLs.

Review typically takes a few days up to ~2 weeks. Until then the app works only for app
role holders — fine for a managed cloud where the operator's team tests, not for public
self-serve connects.

## Operational notes

- User tokens are exchanged for long-lived tokens (~60 days). When a token expires the
  connection shows **auth expired** and the user reconnects; nothing is lost.
- Conversions are sent to the dataset/pixel configured on the connection (`pixel_id` or
  `dataset_id` in the connection metadata). The payload carries hashed identifiers only.
- Spend is read per campaign, ad set and ad; deleted entities are zeroed on
  reconciliation.
- Rate limits are handled with backoff by the outbound queue; failed jobs can be resent
  from *Settings → Ad accounts → Sent conversions*.
