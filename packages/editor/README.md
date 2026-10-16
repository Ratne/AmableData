# @amable/editor

The single configurable Tiptap 3 editor (Simple Editor template, MIT extensions only):
`<AmableEditor mode="rich" | "email" liquidFields={…} />` with email blocks (button, linked
image, divider, spacer, columns, header, footer with mandatory unsubscribe, preheader) and
Liquid authoring (`{{` field picker, visual conditions, raw Liquid). `<EmailPreview>` renders
the document through `@amable/email-render` with a sample recipient.

Documents are Tiptap JSON, stored as-is.
