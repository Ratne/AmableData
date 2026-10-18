# Google app (Calendar)

One Google OAuth client powers the **booking calendars**:

- it reads the host's busy time from Google Calendar (free/busy query,
  `calendar.readonly`) so those slots are not offered on the booking page;
- it writes every booking as an event of the connected calendar (`calendar.events`):
  created on booking, moved on reschedule (or to the new host's calendar), deleted on
  cancellation. The invitee is listed as attendee, but Google sends no invitation:
  confirmations and reminders go out by email from AmableData. Failed writes are retried
  for about 15 hours.

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
   https://www.googleapis.com/auth/calendar.readonly
   https://www.googleapis.com/auth/calendar.events
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

`calendar.readonly` and `calendar.events` are **sensitive** scopes. While the consent screen is in *Testing*,
only listed test users (max 100) can connect and Google shows an "unverified app" warning. For public
production use, submit the app for **verification**: domain ownership (Search Console),
brand review, per-scope justification and usually a short demo video of each flow
(connecting a calendar, a busy slot disappearing from the booking page and a booking
appearing in Google Calendar). Expect
several days to a few weeks.

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
- A booking calendar connection asks for `calendar.readonly` and `calendar.events`.
  Accounts connected with `calendar.readonly` only keep their busy time, but bookings
  are not written: disconnect and reconnect Google to grant the new scope.
