/** The settings screen shell; the logic is in screen.ts (bundled to public/screen.js). */
export function settingsPage(): Response {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>WATI</title>
    <style>
      body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 16px; color: #111; background: transparent; }
      body.dark { color: #eee; }
      p, ol { margin: 0 0 12px; }
      label { display: grid; gap: 4px; margin-bottom: 12px; max-width: 520px; }
      input { font: inherit; padding: 6px 8px; border: 1px solid #ccc; border-radius: 6px; }
      code { display: block; padding: 8px; border-radius: 6px; background: rgba(127,127,127,.12); word-break: break-all; max-width: 520px; }
      button { font: inherit; padding: 6px 12px; border-radius: 6px; border: 0; background: #111; color: #fff; cursor: pointer; }
      button.secondary { background: transparent; color: inherit; border: 1px solid #ccc; margin-left: 8px; }
      #status { color: #666; }
    </style>
  </head>
  <body>
    <p data-i18n="intro">Connect your WATI account to receive and answer WhatsApp messages in Conversations.</p>
    <p id="status"></p>
    <form id="settings">
      <label><span data-i18n="endpoint">API endpoint (WATI → API Docs)</span> <input name="endpoint" placeholder="https://live-mt-server.wati.io/123456" /></label>
      <label><span data-i18n="token">Access token</span> <input name="token" type="password" autocomplete="off" /></label>
      <button type="submit" data-i18n="save">Save</button>
      <button type="button" class="secondary" id="remove" data-i18n="remove">Disconnect</button>
    </form>
    <h3 data-i18n="webhookTitle">Incoming messages</h3>
    <ol>
      <li data-i18n="step1">In WATI open Webhooks and add a webhook with this URL.</li>
      <li data-i18n="step2">Enable the events "Message received", "Message delivered", "Message read" and "Message failed".</li>
    </ol>
    <code id="webhook"></code>
    <p><button type="button" class="secondary" id="copy" data-i18n="copy">Copy URL</button></p>
    <script type="module" src="/screen.js"></script>
  </body>
</html>`;
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}
