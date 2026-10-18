# Changelog

Versions follow `version` in [manifest.json](manifest.json). Code changes go live for every
installation when the apps host is deployed; manifest changes reach them through the catalog.

## 1.0.0 (2026-10-18)

- Verifies the email of new contacts from the CRM, forms and imports (validation hook and batch).
- "Email status" field, Invalid, Risky and Disposable email tags, suggested fix of misspelled domains.
- "Verify email" automation block with state, score, reason, did_you_mean and disposable outputs.
- Settings screen for the Emailable API key, with the credits left.
