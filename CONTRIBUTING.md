# Contributing to amable

Thanks for your interest in amable! You can help by:

- reporting reproducible bugs;
- answering questions in [GitHub Discussions](https://github.com/Ratne/AmableData/discussions);
- fixing issues with a pull request;
- improving translations and documentation.

## Small fix or bigger change?

- **Small and obvious** (typo, narrow bug fix, docs): open a pull request directly.
- **Anything bigger** (new features, UI/UX changes, changes to default behavior,
  refactors, architectural changes, many files touched): open a
  [discussion](https://github.com/Ratne/AmableData/discussions) or an issue first and
  wait for agreement. Pull requests with large unsolicited changes will be closed
  without review.

**One pull request = one logical change.** Don't reformat, refactor or fix style in
unrelated code: send cleanups separately, after discussing them.

## Bug reports

Open an [issue](https://github.com/Ratne/AmableData/issues) only if the bug is
reproducible and not already reported. Include the steps to reproduce, the expected
result and the actual result. Questions go to Discussions.

## Pull requests

- Link the issue or discussion the pull request closes.
- Branch from `main` and target `main`.
- Sign off every commit (`git commit -s`): this is the
  [Developer Certificate of Origin](https://developercertificate.org), certifying you
  wrote the change or have the right to submit it under the AGPL-3.0.
- Describe how you tested the change. Before opening the pull request run:

  ```sh
  pnpm typecheck && pnpm test && pnpm build && pnpm check:names
  ```

### Commit messages and titles

Commits and pull request titles follow
[Conventional Commits](https://www.conventionalcommits.org), in English:

- `fix(email): unsubscribe link ignores the tenant locale`
- `feat(crm): add a phone custom field type`

Keep the description short: the context, not a list of every change.

## Code guidelines

- **TypeScript strict**, no `any`, inputs validated with Zod.
- **Every outside-world dependency behind an interface**, with a fake for tests: no
  network in tests.
- **Database changes are new migrations** in `packages/db`; never edit an applied one.
  They run automatically when the workers boot, on every installation, and must stay
  additive (no drop, rename or `NOT NULL` column without a default) so the previous
  release still works after a rollback (CI checks it).
- **Names**: use the `amable` / `amabledata` brand or neutral names; don't name other
  products in code, comments, file names or commit messages (CI checks it).
- **Formatting**: Prettier (`pnpm format`) on the files you touch.

## AI usage

AI tools are welcome, but you must understand and verify every change you submit, and
it must follow the project patterns. Mention it in the pull request description.
Low-effort generated pull requests will be closed.

## Development

See [Development](README.md#development) in the README to run amable locally. Report
security issues privately as described in [SECURITY.md](SECURITY.md).
