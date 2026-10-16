# @amable/forms

Form definition schema (zod), shared submission validation, widget strings (en/it) and the
edge ↔ core gateway op types (`FormsGatewayOps`).

The embeddable widget (preact) lives in `src/widget` and is bundled by `pnpm --filter @amable/forms build`
into `generated/bundle.ts` (`FORMS_WIDGET_BUNDLE`, `FORMS_WIDGET_BUNDLE_HASH`), exported as
`@amable/forms/bundle`. Rebuild and commit it after changing the widget.
