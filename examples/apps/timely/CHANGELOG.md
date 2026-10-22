# Changelog

Versions follow `version` in [manifest.json](manifest.json). Each version is a released bundle;
installations get it, and the manifest changes, through the catalog.

## 1.0.1 (2026-10-22)

- Deadlines are announced to automations in batches until the backlog is empty (up to 900 events
  a minute, was 200): fixed-date campaigns expiring for many contacts close on time.
- Note in the editor and the README: Apple Mail and Gmail may download the timer image before the
  email is read, so "email open" can start the countdown early.

## 1.0.0 (2026-10-22)

- Evergreen and fixed-date campaigns with one stored deadline per contact or anonymous visitor.
- Animated email timer (GIF) per contact, and email links that start the countdown and carry the
  contact to the page.
- Embeddable page widget, inline or as a bar, with expiry actions (zeros, message, hide, redirect).
- Designer with five presets, colors, units, labels and custom CSS, with live previews.
- Contacts tab: reset, restart, extend or set deadlines; start a countdown by hand.
- "Start Timely deadline" automation action; deadline started and expired triggers.
- Page in the Marketing menu.
