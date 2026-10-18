# Google app (Google Ads)

Connecting Google Ads needs **two** credentials with separate approval tracks:

1. an **OAuth client** in a Google Cloud project (who the user grants access to);
2. a **developer token** from a Google Ads *manager account* (your quota for the
   Google Ads API itself).

Scope requested: `https://www.googleapis.com/auth/adwords`
(`GOOGLE_ADS_DEFAULT_SCOPES` in `packages/ads-providers/src/google-ads.ts`).

## 1. OAuth client (Google Cloud)

1. Create a project at [console.cloud.google.com](https://console.cloud.google.com)
   (reusing the Calendar/Sheets project is possible — see
   [the trade-off](google-calendar-sheets.md#one-project-or-two)).
2. *APIs & Services → Library*: enable **Google Ads API**.
3. *APIs & Services → OAuth consent screen* (Google Auth Platform): user type
   **External**, fill app name, support email, authorized domain, links to privacy policy
   and terms. Add the scope `…/auth/adwords`.
4. *Credentials → Create credentials → OAuth client ID* → type **Web application** →
   authorized redirect URI:

   ```text
   https://<your dashboard host>/oauth/ads/callback
   ```

5. Note the **Client ID** and **Client secret**.

While the consent screen is in **Testing**, only listed test users (max 100) can connect.
Publishing to production with a sensitive scope like `adwords` requires **app
verification** (domain ownership via Search Console, brand review, scope justification,
usually a demo video). Expect several days to a few weeks; plan it early.

## 2. Developer token (Google Ads manager account)

1. Create or use a [manager account (MCC)](https://ads.google.com/home/tools/manager-accounts/).
2. In the manager account: *Admin → API Center* → apply for API access. The token starts
   at **Test account** level (works only against Google Ads *test* accounts), then apply
   for **Basic access** (form review, typically a few business days), later **Standard**
   for higher limits.
3. The token is a string, independent from the Cloud project.

## 3. Configure AmableData

```sh
cd apps/core
wrangler secret put GOOGLE_ADS_CLIENT_ID
wrangler secret put GOOGLE_ADS_CLIENT_SECRET
wrangler secret put GOOGLE_ADS_DEVELOPER_TOKEN
# only if customer accounts are reached through your manager account:
wrangler secret put GOOGLE_ADS_LOGIN_CUSTOMER_ID   # digits, dashes are stripped
```

All three first values are required; without any of them the Google card shows as
unavailable. `GOOGLE_ADS_LOGIN_CUSTOMER_ID` is optional: set it to your manager account ID
when the accounts users connect are accessed through that MCC (it is sent as the
`login-customer-id` header).

## 4. Conversions (upload click conversions)

Outbound conversions use `uploadClickConversions` with `gclid` / `wbraid` / `gbraid`,
hashed user identifiers (enhanced conversions) and `orderId` for dedup. Prerequisites in
the customer's Google Ads account:

- a conversion action of type **Import → Other data sources → API**;
- the outbound mapping's **event name must be the conversion action ID** (the digits in
  its detail URL) or the full `customers/{cid}/conversionActions/{id}` resource name;
- enhanced conversions for leads enabled on the action if hashed identifiers should
  match.

The target account defaults to the connected account; override with `customer_id` in the
connection metadata.

## Operational notes

- Refresh tokens are used; a revoked grant surfaces as **auth expired** on the connection
  and the user reconnects.
- With a *Test account* level token, real accounts return `DEVELOPER_TOKEN_NOT_APPROVED`
  — that is the token level, not a bug.
- Spend is read per campaign, ad group and ad through GAQL; currency follows the ad
  account.
