/** The settings screen shell; the logic is in screen.ts (bundled to public/screen.js). */
export function settingsPage(): Response {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Emailable</title>
    <style>
      body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 16px; color: #111; background: transparent; }
      body.dark { color: #eee; }
      p { margin: 0 0 12px; }
      label { display: grid; gap: 4px; margin-bottom: 12px; max-width: 420px; }
      input { font: inherit; padding: 6px 8px; border: 1px solid #ccc; border-radius: 6px; }
      button { font: inherit; padding: 6px 12px; border-radius: 6px; border: 0; background: #111; color: #fff; cursor: pointer; }
      button[type="button"] { background: transparent; color: inherit; border: 1px solid #ccc; margin-left: 8px; }
      #status { color: #666; }
    </style>
  </head>
  <body>
    <p data-i18n="intro">New contacts are verified with your Emailable account. The outcome goes to the "Email status" field and to tags.</p>
    <p id="status"></p>
    <form id="settings">
      <label><span data-i18n="key">Emailable API key</span> <input name="api_key" type="password" autocomplete="off" /></label>
      <button type="submit" data-i18n="save">Save</button>
      <button type="button" id="remove" data-i18n="remove">Remove key</button>
    </form>
    <script type="module" src="/screen.js"></script>
  </body>
</html>`;
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}
