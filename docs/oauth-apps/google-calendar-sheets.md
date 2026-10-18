# Google app (Calendar)

One Google OAuth client powers the **booking calendars**: read availability (busy slots)
and write booking events to the host's Google Calendar (`calendar.events` +
`calendar.readonly`).

Form exports to Google Sheets need no app here: each workspace uploads the JSON key of
its own Google service account in the form connection and shares the spreadsheet with
the account's email as Editor (the steps are shown in the connection dialog).

Scopes are defined in `OAUTH_SCOPES` (`packages/core/src/oauth.ts`); the callback path is
fixed: `<APP_ORIGIN>/oauth/google/callback`.

On the managed offering (`LICENSE_KEY` set) these connections are brokered by the control
plane and no app is needed; an own app, when configured, always takes precedence. Dev
(`ENVIRONMENT=dev`) uses a stub, no app needed.

## 1. Create the OAuth client

1. Create a Google Cloud project at
   [console.cloud.google.com](https://console.cloud.google.com).
2. *APIs & Services → Library*: enable **Google Calendar API**.
3. *APIs & Services → OAuth consent screen*: user type **External**; app name, support
   email, authorized domain, privacy policy and terms URLs. Add the scopes:

   ```text
   https://www.googleapis.com/auth/calendar.events
   https://www.googleapis.com/auth/calendar.readonly
   ```

4. *Credentials → Create credentials → OAuth client ID* → **Web application** →
   authorized redirect URI:

   ```text
   https://<your dashboard host>/oauth/google/callback
   ```

5. Note the **Client ID** and **Client secret**.

## 2. Configure AmableData

```sh
cd apps/core
wrangler secret put GOOGLE_OAUTH_CLIENT_ID
wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
```

After deploy, the connect buttons appear in the booking calendar settings. Grants are
encrypted with the installation key (`AUTH_ENCRYPTION_KEY`) before being stored in the installation database; disconnecting deletes them.

## 3. Verification (to let customers connect)

Both scopes are **sensitive**. While the consent screen is in *Testing*, only listed
test users (max 100) can connect and Google shows an "unverified app" warning. For public
production use, submit the app for **verification**: domain ownership (Search Console),
brand review, per-scope justification and usually a short demo video of each flow
(booking created in Calendar). Expect several days to a few weeks.

## One project or two?

The Google Ads client ([google-ads.md](google-ads.md)) can live in the same Cloud project
or a separate one:

- **Same project** — one consent screen, one verification covering `adwords` + calendar.
  Simpler, but any review issue blocks every Google feature at once.
- **Separate projects** (recommended) — independent verification timelines; calendar
  bookings do not wait for the ads review. The two clients then have different IDs and
  secrets (`GOOGLE_OAUTH_*` vs `GOOGLE_ADS_*`), which the configuration already keeps
  apart.

## Operational notes

- Refresh tokens are used; a revoked grant makes the account show as disconnected and the
  user reconnects from the same settings page.
- Scope grants follow the feature: a booking calendar connection asks only for the two
  calendar scopes.
