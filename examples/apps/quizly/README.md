# Quizly for AmableData

Quiz funnels, in the style of Thrive Quiz Builder. A quiz is a chain of questions: every choice
gives points, may apply CRM tags and may open its own path; at the end the score picks the
result, with its thank-you page and its tag. Answers reach the contact while they are given, so a
quiz left halfway still says something about the lead.

Once installed, the **Quizly** page appears in the **Marketing** menu (`nav_group: "marketing"`
in the manifest).

## Quizzes

- **Questions**: multiple choice (with optional images) or open (short or long, required or
  not). Each answer has its points, optional tags and where to go next: the next step, a later
  step, or straight to the result. Jumps only go forward, so every path ends and the highest
  possible score is exact.
- **Opt-in**: a step with one of the workspace's forms, as built in Forms, with its fields, its
  connections (integrations, HTTP webhooks) and its automations. Once it is sent the quiz knows
  the contact: the answers given so far and the next ones reach it. It can be skippable, and
  there can be none at all: a quiz without opt-in works, it just sends nothing to the CRM unless
  the link names the contact.
- **Results**: score ranges, the first that contains the score wins. Each has a label, a
  message or a thank-you page, and an optional tag. A default page or message covers scores no
  range contains.
- **Look and settings**: colors, rounded corners, font, custom CSS, language (Italian or
  English), welcome screen, progress bar, back button, button labels.
- **Statistics**: started, finished, completion, contacts, average score; how many answered
  each question and how the answers split; how the results split.
- **Answers**: every session, anonymous or with its contact, its score, result and answers.
- **Preview**: the saved quiz in the editor or in a new tab, also while it is a draft. Previews
  are not counted and never reach the CRM.

## Code to paste

The quiz's "Code to paste" tab has everything ready to copy, with the address of the workspace's
own copy of the app (`<subdomain>` is the Cloudflare account's `workers.dev` subdomain):

| Where | What |
| --- | --- |
| Landing page, HTML block, or any website | `<div data-quizly="<id>"></div><script async src="https://amable-app-quizly.<subdomain>.workers.dev/embed.js"></script>` |
| Link (share it, or use it as a page) | `https://amable-app-quizly.<subdomain>.workers.dev/q/<id>` |
| Email | `…/q/<id>?c={{ contact.id }}` |

The embed becomes an iframe as tall as the quiz; the result page opens in the embedding page.
The page's `email`, `c` and campaign parameters (`utm_*`, `gclid`, `fbclid`…) go along to the
quiz, and `data-quizly-email` / `data-quizly-contact` set the contact from the page itself. A
contact named by the link (`c`, or an `email` of a contact already in the CRM; Quizly never
creates contacts) skips the opt-in steps.

## What reaches the CRM

As soon as the session knows its contact (from the link or from the opt-in form):

- the tags of every chosen answer, once each;
- a summary on the contact (app values `quiz_<id>`: status, score, result, the answers so far),
  updated at each answer.

When the quiz is finished, once per session:

- the result's tag;
- the custom fields **Last quiz**, **Last quiz score** and **Last quiz result**;
- the automation trigger **Quiz completed**, with `quiz_id`, `quiz_name`, `score`, `max_score`
  and `result`;
- a timeline entry with the score and the answers.

The score is always computed by the app from the stored answers, never by the browser, and only
the answers on the path the respondent took count. The quiz page gets no points, tags or results.
A result the CRM could not take for a moment is sent again the next time a quiz is used.

The opt-in form tells Quizly its `submission_id` (the forms widget emits the cancelable
`amable-form:submitted` event on its element; Quizly cancels the form's own redirect), and the
`form.submitted` webhook brings the contact of that submission. Either may come first.

## Tests

```sh
pnpm --filter @amable/example-app-quizly test        # offline: in-memory D1, fake CRM
pnpm --filter @amable/example-app-quizly typecheck
```

The tests run the scoring and branching rules, the editor (tags found or created, opt-in forms
and their domain check), the public flow with known, anonymous and later-linked contacts in both
orders, retries, privacy and uninstall, and the conformance suite.

## Hosting

The app never runs on AmableData's Cloudflare account. When a workspace installs it from the
Marketplace, the CRM deploys its bundle into the installation's **own** Cloudflare account: the
Worker `amable-app-quizly` on its `workers.dev` address and the D1 database `amable-app-quizly-db`.
On AmableData Cloud the token saved in the portal during setup is used; on a self-hosted
installation an owner connects a token (Workers Scripts and D1, Edit) the first time. Uninstalling
deletes the Worker and the database.

There is nothing to configure: on the first request the app creates its tables and its Ed25519
signing key in its database. An `APP_KEYS` variable, if set, takes precedence. The quiz pages are
served by the Worker itself; when an opt-in form limits its allowed domains, add the Worker's
address to them (the editor warns about it).

```sh
pnpm --filter @amable/example-app-quizly dev                  # local Worker with a local D1 (wrangler.jsonc)
node scripts/release-app.mjs quizly --publish   # maintainers, from the repo root, after bumping "version"
```

The release script builds `dist/worker.mjs` (screens inlined), attaches it to the GitHub release
`app-quizly-v<version>` and writes the catalog manifest with its SHA-256 into the
[amable-apps](https://github.com/Ratne/amable-apps) checkout next to this repository.

## Privacy

Quizly stores, per installation, its quizzes and, per session, the answers, the score, the result
and the CRM id of the contact when known. It stores no email: contacts are looked up in the CRM
and only their id is kept. It reads contacts to recognise the one named by a link and to show
names in the Answers tab. Unfinished anonymous sessions are deleted after 90 days. A privacy
erasure request deletes the contact's sessions and answers; a data request returns them.
Uninstalling the app deletes all quizzes and answers of the installation.
