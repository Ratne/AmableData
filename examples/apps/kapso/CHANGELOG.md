# Changelog

Versions follow `version` in [manifest.json](manifest.json). Each version is a released bundle;
installations get it, and the manifest changes, through the catalog.

## 1.0.1 (2026-10-22)

- Uninstalling deletes the webhook at Kapso also when the app had not been used for a while
  (the settings are read again from the CRM, not only from memory).
- The composer explains why there are no templates: WhatsApp not connected, sandbox number, or
  no approved templates yet. The automation block lists at most 500 templates.

## 1.0.0 (2026-10-18)

- Connects the team's WhatsApp number through Kapso's hosted onboarding.
- Shared inbox channel with the 24-hour reply window and templates to reopen conversations.
- Page to create WhatsApp templates (languages, categories) and submit them to Meta.
- "Send WhatsApp template" automation block; message received and opt-out triggers.
