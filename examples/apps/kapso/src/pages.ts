/** Screen shells (logic in settings-screen.ts and templates-screen.ts, bundled to public/) and the onboarding result pages. */

const STYLE = `
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 16px; color: #111; background: transparent; }
  body.dark { color: #eee; }
  h2 { font-size: 15px; margin: 20px 0 8px; }
  p { margin: 0 0 12px; }
  .muted { color: #666; }
  body.dark .muted { color: #aaa; }
  label { display: grid; gap: 4px; margin-bottom: 12px; max-width: 520px; }
  input, select, textarea { font: inherit; padding: 6px 8px; border: 1px solid #ccc; border-radius: 6px; background: transparent; color: inherit; }
  textarea { min-height: 96px; }
  button { font: inherit; padding: 6px 12px; border-radius: 6px; border: 0; background: #111; color: #fff; cursor: pointer; }
  body.dark button { background: #eee; color: #111; }
  button.ghost { background: transparent; color: inherit; border: 1px solid #ccc; }
  button + button { margin-left: 8px; }
  table { border-collapse: collapse; width: 100%; max-width: 900px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #ddd; vertical-align: top; }
  .badge { font-size: 12px; padding: 1px 6px; border-radius: 999px; border: 1px solid currentColor; }
  .APPROVED { color: #15803d; } .PENDING { color: #b45309; } .REJECTED, .PAUSED, .DISABLED { color: #b91c1c; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: end; }
  .row label { margin: 0; }
  .pre { white-space: pre-wrap; }
  [hidden] { display: none !important; }
`;

/** `<base>` makes the script and the API calls relative to `base_url`, wherever the app is hosted. */
function shell(baseUrl: string, title: string, body: string, script: string): Response {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <base href="${baseUrl}/" />
    <title>${title}</title>
    <style>${STYLE}</style>
  </head>
  <body>
${body}
    <script type="module" src="${script}"></script>
  </body>
</html>`;
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export function settingsPage(baseUrl: string): Response {
  return shell(
    baseUrl,
    'Kapso',
    `    <p data-i18n="intro">Connect a WhatsApp number through Kapso: conversations land in the shared inbox, and automations can send approved templates.</p>
    <section id="key-section">
      <h2 data-i18n="step1">1. Kapso API key</h2>
      <p class="muted" data-i18n="keyHint">Create it in Kapso under Project settings → API keys.</p>
      <p id="key-status" class="muted"></p>
      <form id="key-form" class="row">
        <label><span data-i18n="key">API key</span><input name="api_key" type="password" autocomplete="off" size="40" /></label>
        <button type="submit" data-i18n="save">Save</button>
        <button type="button" class="ghost" id="remove-key" data-i18n="remove">Remove</button>
      </form>
    </section>
    <section id="number-section" hidden>
      <h2 data-i18n="step2">2. WhatsApp number</h2>
      <p id="number-status"></p>
      <div class="row">
        <label><span data-i18n="pick">Number of the Kapso project</span><select id="numbers"></select></label>
        <button type="button" id="use-number" data-i18n="use">Use this number</button>
        <button type="button" class="ghost" id="disconnect" data-i18n="disconnect">Disconnect</button>
      </div>
      <h2 data-i18n="newTitle">Connect a new number</h2>
      <p class="muted" data-i18n="newHint">Opens Meta's signup in a new tab: use a new number, or keep the WhatsApp Business app on your phone (coexistence). Come back here when it is done.</p>
      <button type="button" class="ghost" id="connect" data-i18n="connect">Connect a number with Kapso</button>
    </section>`,
    'settings.js',
  );
}

export function templatesPage(baseUrl: string): Response {
  return shell(
    baseUrl,
    'WhatsApp templates',
    `    <p data-i18n="intro">Templates are the only messages WhatsApp lets you send when the contact has not written in the last 24 hours. Meta reviews each one before it can be used.</p>
    <p id="status" class="muted"></p>
    <section id="list-section">
      <table>
        <thead><tr><th data-i18n="name">Name</th><th data-i18n="language">Language</th><th data-i18n="category">Category</th><th data-i18n="state">Status</th><th data-i18n="text">Text</th><th></th></tr></thead>
        <tbody id="templates"></tbody>
      </table>
    </section>
    <section id="create-section">
      <h2 data-i18n="create">New template</h2>
      <form id="create">
        <div class="row">
          <label><span data-i18n="name">Name</span><input name="name" required pattern="[a-z0-9_]+" placeholder="order_update" /></label>
          <label><span data-i18n="language">Language</span>
            <select name="language">
              <option value="it">Italiano (it)</option><option value="en">English (en)</option><option value="en_US">English US (en_US)</option>
              <option value="en_GB">English UK (en_GB)</option><option value="es">Español (es)</option><option value="fr">Français (fr)</option>
              <option value="de">Deutsch (de)</option><option value="pt_BR">Português BR (pt_BR)</option><option value="pt_PT">Português PT (pt_PT)</option>
              <option value="nl">Nederlands (nl)</option><option value="ro">Română (ro)</option><option value="ar">العربية (ar)</option>
            </select>
          </label>
          <label><span data-i18n="category">Category</span>
            <select name="category">
              <option value="UTILITY" data-i18n="utility">Utility (orders, appointments, account)</option>
              <option value="MARKETING" data-i18n="marketing">Marketing (offers, news)</option>
              <option value="AUTHENTICATION" data-i18n="authentication">Authentication (one-time codes)</option>
            </select>
          </label>
        </div>
        <div id="content-fields">
          <label><span data-i18n="header">Header (optional, up to 60 characters)</span><input name="header" maxlength="60" /></label>
          <label><span data-i18n="body">Text</span><textarea name="body" maxlength="1024" placeholder="Hi {{first_name}}, your appointment is on {{date}}."></textarea></label>
          <p class="muted" data-i18n="paramsHint">Parameters are names in double braces, such as {{first_name}}. Meta wants an example for each.</p>
          <div id="examples"></div>
          <label><span data-i18n="footer">Footer (optional)</span><input name="footer" maxlength="60" /></label>
          <h2 data-i18n="buttons">Buttons (optional)</h2>
          <div id="buttons"></div>
          <button type="button" class="ghost" id="add-button" data-i18n="addButton">Add a button</button>
        </div>
        <div id="auth-fields" hidden>
          <p class="muted" data-i18n="authHint">Meta writes the text of authentication templates: you send the code as the parameter {{1}}.</p>
          <label><input type="checkbox" name="security_recommendation" /> <span data-i18n="security">Add "do not share this code"</span></label>
          <label><span data-i18n="expiry">Code expires after (minutes, optional)</span><input name="code_expiration_minutes" type="number" min="1" max="90" /></label>
        </div>
        <p><button type="submit" data-i18n="submit">Submit to Meta for review</button></p>
      </form>
    </section>`,
    'templates.js',
  );
}

const RESULT = {
  connected: (detail: string | null) => ({
    title: 'WhatsApp connected · WhatsApp collegato',
    en: `The number ${detail ?? ''} is now the WhatsApp channel of your workspace. You can close this tab.`,
    it: `Il numero ${detail ?? ''} è ora il canale WhatsApp del tuo workspace. Puoi chiudere questa scheda.`,
  }),
  failed: (detail: string | null) => ({
    title: 'WhatsApp not connected · WhatsApp non collegato',
    en: `The connection did not complete (${detail ?? 'unknown error'}). Close this tab and try again from the Kapso app settings.`,
    it: `Il collegamento non è andato a buon fine (${detail ?? 'errore sconosciuto'}). Chiudi questa scheda e riprova dalle impostazioni dell'app Kapso.`,
  }),
  expired: () => ({
    title: 'Link expired · Link scaduto',
    en: 'This connection link has expired or was already used. Start again from the Kapso app settings.',
    it: "Questo link di collegamento è scaduto o è già stato usato. Ricomincia dalle impostazioni dell'app Kapso.",
  }),
};

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);

/** Where Kapso's onboarding sends the admin back (a full tab, not an iframe). */
export function resultPage(kind: keyof typeof RESULT, detail: string | null = null): Response {
  const text = RESULT[kind](detail === null ? null : detail.slice(0, 100));
  const html = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${escapeHtml(text.title)}</title>
  <style>body { font: 16px/1.5 system-ui, sans-serif; max-width: 560px; margin: 15vh auto; padding: 0 16px; }</style></head>
  <body><h1>${escapeHtml(text.title)}</h1><p>${escapeHtml(text.en)}</p><p lang="it">${escapeHtml(text.it)}</p></body>
</html>`;
  return new Response(html, {
    status: kind === 'connected' ? 200 : 400,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}
