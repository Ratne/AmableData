# Timely for AmableData

Countdown timers that are true, in the style of Deadline Funnel. Every contact gets one deadline
per campaign, stored by the app: the animated timer in the email, the timer on the landing page
and the automations all read the same deadline, so reopening the email, changing device or
reloading the page never gives more time.

Once installed, the **Timely** page appears in the **Marketing** menu (`nav_group: "marketing"`
in the manifest).

## Campaigns

- **Evergreen**: each contact has their own countdown (for example 48 hours), started by the
  first of the triggers the campaign allows: opening an email with the timer, clicking a Timely
  link, visiting a page with the timer (anonymous visitors too, by a random id in the browser),
  or the "Start Timely deadline" automation step. "Never later than" caps every deadline at a date.

  > **Email opens start early.** Apple Mail (Mail Privacy Protection) and Gmail download images
  > through their proxies, often as soon as the email arrives and before the contact reads it, so
  > an "email open" can start the countdown hours early. For strict campaigns, start the countdown
  > on a click, a page visit or the automation step instead.

- **Fixed date**: the same deadline for everyone.
- **Look**: five presets (classic, minimal, bold, neon, soft), colors, boxes, rounded corners,
  separators, units, size, weight, label language and text, expired message, and custom CSS for
  the page widget. The editor previews the email GIF and the page widget side by side.
- **When the time is up** pages show zeros, show the expired message, hide the timer, or go to
  the expired page; Timely links open the expired page instead of the offer.
- **Contacts**: the deadlines of the campaign, searchable; reset (the countdown starts again at
  the next trigger), restart now, extend, or set a date, for some contacts or for all. A
  countdown can also be started by hand for a contact.

## Code to paste

The campaign's "Code to paste" tab has everything ready to copy, with the address of the
workspace's own copy of the app (`<subdomain>` is the Cloudflare account's `workers.dev` subdomain):

| Where | What |
| --- | --- |
| Email, HTML block | `<a href="…/r/<id>?c={{ contact.id }}"><img src="…/i/<id>/c/{{ contact.id }}.gif"></a>` |
| Email, image block | `https://amable-app-timely.<subdomain>.workers.dev/i/<id>/c/{{ contact.id }}.gif` |
| Landing page, HTML block, or any website | `<div data-timely="<id>"></div><script async src="https://amable-app-timely.<subdomain>.workers.dev/widget.js"></script>` |

`{{ contact.id }}` is filled in by the CRM when the email is sent. The GIF is drawn when the email
is opened: 60 one-second frames, then it stops on the last one (mail clients do not run scripts;
reopening the email shows the time left then). Timely links carry a signed token (`tly`) to the
page, which ties the deadline to the contact in any browser; a visitor who already had an
anonymous countdown on that browser keeps the earlier deadline.

The widget options are `data-timely-mode="bar"` (a bar fixed to the page) and
`data-timely-position="bottom"`. It emits `timely:expired` on the element when the time is up.

## Automations

- Action **Start Timely deadline** (campaign, optional duration in hours, restart): outputs
  `deadline_at`, `campaign_name`, `timer_url` and `link_url` for the next steps.
- Triggers **Timely deadline started** and **Timely deadline expired**, with `campaign_id`,
  `campaign_name` and `deadline_at`. They come from a job that runs every minute; a deadline that
  is restarted or extended fires them again.

## Tests

```sh
pnpm --filter @amable/example-app-timely test        # offline: in-memory D1, fake CRM
pnpm --filter @amable/example-app-timely typecheck
```

The tests decode every GIF frame (LZW included), run the full lifecycle against an in-memory
SQLite with D1's API, and pass the conformance suite.

## Hosting

The app never runs on AmableData's Cloudflare account. When a workspace installs it from the
Marketplace, the CRM deploys its bundle into the installation's **own** Cloudflare account: the
Worker `amable-app-timely` on its `workers.dev` address and the D1 database `amable-app-timely-db` with its every-minute cron.
On AmableData Cloud the token saved in the portal during setup is used; on a self-hosted
installation an owner connects a token (Workers Scripts and D1, Edit) the first time. Uninstalling
deletes the Worker and the database.

There is nothing to configure: on the first request the app creates its tables and its Ed25519
signing key in its database (`amable_app_keys`, one row written with `INSERT OR IGNORE`, so
isolates starting together end up with the same key). Email links are
signed with a secret derived from that key. An `APP_KEYS` variable, if set, takes precedence;
the first key signs and every key verifies, so a new key can be put in front without breaking
links already sent.

```sh
pnpm --filter @amable/example-app-timely dev                  # local Worker with a local D1 (wrangler.jsonc)
node scripts/release-app.mjs timely --publish   # maintainers, from the repo root, after bumping "version"
```

The release script builds `dist/worker.mjs` (screens inlined), attaches it to the GitHub release
`app-timely-v<version>` and writes the catalog manifest with its SHA-256 into the
[amable-apps](https://github.com/Ratne/amable-apps) checkout next to this repository.

## Privacy

Timely stores, per installation, its campaigns and, per contact or anonymous visitor, the start
and the end of their deadline and what started it. It reads contacts only to check that a contact
exists before starting a deadline and to show names in the Contacts tab. Anonymous visitors are a
random id kept in their browser's local storage; the timer requests carry no cookies. A privacy
erasure request deletes the contact's deadlines; a data request returns them. Uninstalling the app
deletes all campaigns and deadlines of the installation.
