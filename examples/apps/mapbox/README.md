# Mapbox for AmableData

Reference app (MIT): address autocomplete on the contact editor through the workspace's own
[Mapbox](https://www.mapbox.com) access token. It shows the address lookup extension
(`extensions.address_lookup`) and a settings screen that checks a token with the provider before
storing it encrypted in the installation's app data.

## What it does

Out of the box the CRM suggests addresses from OpenStreetMap (a public Photon instance, or the
one set in `ADDRESS_LOOKUP_URL`). Its coverage is good in cities and sometimes thin in small
towns. Once this app is installed and a token is saved, the contact editor asks Mapbox Geocoding
v6 instead: addresses and streets, in the user's language, restricted to the country picked on
the address, with the province (not the region) in Italy and Spain.

| Situation                                            | Suggestions from                                    |
| ---------------------------------------------------- | --------------------------------------------------- |
| No token saved                                       | OpenStreetMap                                       |
| Token saved                                          | Mapbox, `© Mapbox © OpenStreetMap` shown under them |
| Mapbox slower than 3 s, rate-limited, token rejected | OpenStreetMap, for that search                      |
| App paused or uninstalled                            | OpenStreetMap                                       |

Mapbox has a monthly free tier, then bills by its price list. Its terms let you keep results only
with **permanent geocoding** (priced apart): the CRM stores the address the user picks, so decide
on the toggle in the settings screen after reading Mapbox's terms. When it is on, every request
carries `permanent=true`.

Create the token under **Tokens** on [account.mapbox.com](https://account.mapbox.com/access-tokens/)
with no URL restrictions: requests come from the app's server, not the browser.

## Tests

`pnpm test` (from the repo root: `pnpm vitest run examples/apps/mapbox`) replays the Mapbox
answers in `test/fixtures/mapbox/` against the app and an in-memory CRM, with no network. They are
the examples of Mapbox's API reference (`"source": "docs"`, linked in `docs_url`): the forward
geocoding response and the 401, 403 and 429 errors.

## Hosting

The official copy runs at `https://apps.amabledata.com/mapbox` inside the [apps host](../host),
one Worker for every official app. To run your own copy, follow the steps in the
[Emailable README](../emailable#hosting) with `@amable/example-app-mapbox`.

## Privacy

The app stores no data about contacts. What the user types in the address field is sent to
Mapbox only to search it, with the workspace's token, under Mapbox's own terms. The token is
encrypted by the CRM and readable only by this app's installation; removing it from the settings
screen or uninstalling the app deletes it.
