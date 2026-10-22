# Changelog

Versions follow `version` in [manifest.json](manifest.json). Each version is a released bundle;
installations get it, and the manifest changes, through the catalog.

## 1.0.1 (2026-10-22)

- An `email` in the link still links the session to its contact, but no longer skips the opt-in:
  the answer no longer tells whether an address belongs to a contact.
- Cron every 10 minutes: results the CRM refused for a moment are sent again even without traffic.
- README: finished anonymous sessions are kept for the statistics.

## 1.0.0 (2026-10-22)

- Quizzes with multiple-choice and open questions, points, tags and a path for each answer.
- Opt-in steps with the workspace's forms (their connections and automations keep working).
- Answers, tags and a summary on the contact as soon as it is known, also for unfinished quizzes.
- Score ranges with thank-you page, message and tag; custom fields, timeline entry and the
  "Quiz completed" automation trigger.
- Embed code, shareable link and email link; contacts recognised by `c` or `email`.
- Editor with look, settings, preview, statistics and answers, in the Marketing menu.
