/**
 * The settings screen shell; the logic is in screen.ts (bundled to public/screen.js).
 * `<base>` makes the script and the API calls relative to `base_url`, wherever the app is hosted.
 */
export function settingsPage(baseUrl: string): Response {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <base href="${baseUrl}/" />
    <title>Mapbox</title>
    <style>
      body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 16px; color: #111; background: transparent; }
      body.dark { color: #eee; }
      p { margin: 0 0 12px; }
      a { color: inherit; }
      label { display: grid; gap: 4px; margin-bottom: 12px; max-width: 420px; }
      label.check { display: flex; align-items: flex-start; gap: 8px; max-width: 560px; }
      label.check input { margin-top: 4px; }
      small { color: #666; }
      input[type="password"] { font: inherit; padding: 6px 8px; border: 1px solid #ccc; border-radius: 6px; }
      button { font: inherit; padding: 6px 12px; border-radius: 6px; border: 0; background: #111; color: #fff; cursor: pointer; }
      button[type="button"] { background: transparent; color: inherit; border: 1px solid #ccc; margin-left: 8px; }
      #status { color: #666; }
    </style>
  </head>
  <body>
    <p data-i18n="intro">Mapbox suggests addresses while you type on the contact page, with more complete data than the built-in OpenStreetMap search, including streets and house numbers in small towns. Searches use your own Mapbox account: it has a monthly free tier, then bills by its price list. If Mapbox does not answer, OpenStreetMap is used.</p>
    <p data-i18n="tokenHint">Create a token under Tokens on account.mapbox.com, with no URL restrictions: requests come from the app's server, not the browser. It is checked with Mapbox and stored encrypted.</p>
    <p id="status"></p>
    <form id="settings">
      <label><span data-i18n="token">Mapbox access token</span> <input name="token" type="password" autocomplete="off" spellcheck="false" placeholder="pk.eyJ1Ijoi…" /></label>
      <label class="check">
        <input name="permanent" type="checkbox" />
        <span><span data-i18n="permanent">Permanent geocoding</span><br /><small data-i18n="permanentHint">Mapbox terms allow keeping results only with permanent geocoding, which is priced apart from the free tier. The CRM stores the chosen address: check costs and terms on the Mapbox site before deciding.</small></span>
      </label>
      <button type="submit" data-i18n="save">Save</button>
      <button type="button" id="remove" data-i18n="remove">Remove token</button>
    </form>
    <script type="module" src="screen.js"></script>
  </body>
</html>`;
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}
