# App API changelog

Versions follow the [deprecation policy](README.md#api-versions): a superseded version is served
for 12 months after its successor ships. Additions within a version are listed under it.

## 2026-10

First version.

- Manifest `schema_version` 1.
- OAuth with `private_key_jwt`, refresh token rotation, installation discovery at
  `/.well-known/amable-apps.json`.
- Signed calls (`Amable-Signature`), events with `sequence` and replay (`GET /apps/events`).
- Extension points: `contact.validate` (single and batch), `automation.actions`,
  `automation.triggers`, `form.connectors`, `conversations.channels`, `contact.timeline`,
  `app.data`, `app.entity_data`, UI slots `contact.sidebar`, `contact.actions`, `app.page`,
  `app.settings`, `dashboard.widget`.
- Privacy endpoints for erasure and data requests.
