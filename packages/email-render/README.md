# @amable/email-render

Tiptap JSON → email-safe HTML (React Email tables, inline CSS, fixed width) + plain text,
runnable in Workers, Node and the browser.

```ts
const renderer = createRecipientRenderer(compileEmail(doc, { subject, footerAddress }));
const { subject, html, text } = await renderer.render({ contact, unsubscribe_url });
```

Liquid is resolved per recipient after conversion in a sandboxed LiquidJS, then the HTML is
sanitized. A footer with the unsubscribe link is enforced unless `requireUnsubscribe: false`.
