# Changelog

Versions follow `version` in [manifest.json](manifest.json). Each version is a released bundle;
installations get it, and the manifest changes, through the catalog.

## 1.0.1 (2026-10-22)

- Saving a key while Emailable is not answering says so, instead of "Emailable refused this key";
  only a 401/403 counts as a refused key.

## 1.0.0 (2026-10-18)

- Verifies the email of new contacts from the CRM, forms and imports (validation hook and batch).
- "Email status" field, Invalid, Risky and Disposable email tags, suggested fix of misspelled domains.
- "Verify email" automation block with state, score, reason, did_you_mean and disposable outputs.
- Settings screen for the Emailable API key, with the credits left.
