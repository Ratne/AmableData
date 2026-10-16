# @amable/builder

Landing page builder shared by the SPA editor, the core API and the edge SSR:

- **schema** — `BuilderDocument` (`editorKind`, `tokens`, `body: ElementNode[]`, `customCss?`), breakpoints,
  style variants, `validateBuilderDocument`, `sanitizeBuilderDocument`;
- **catalog** — `WIDGETS` / `WIDGET_LIST` / `getWidgetDef`, control helpers, Advanced tab, shape dividers,
  Google fonts; labels are English, `BUILDER_LABELS_IT` / `builderLabel(label, locale)` localize them;
- **ops** — `CanvasOp`, `applyCanvasOp`, `invertCanvasOp` (undo/redo);
- **render** — `renderBuilderPage` / `renderBuilderDocumentHtml` (mode `public` | `editor`), `builderPageCsp`.

Native widgets: `form` (settings `formId`) and `booking` (settings `eventSlug`) render the amable embed markup
and add `/forms.js` / `/booking.js` once per page.
