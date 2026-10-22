/** Screen shells; the logic is in campaigns-screen.ts and settings-screen.ts, bundled to public/. */

const STYLE = `
  :root { color-scheme: light; --fg: #111827; --muted: #6b7280; --line: #e5e7eb; --card: #ffffff; --soft: #f9fafb; --accent: #4f46e5; --danger: #b91c1c; }
  body.dark { color-scheme: dark; --fg: #f3f4f6; --muted: #9ca3af; --line: #374151; --card: #111827; --soft: #1f2937; --accent: #818cf8; --danger: #f87171; }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 16px; color: var(--fg); background: transparent; }
  h1 { font-size: 18px; margin: 0; } h2 { font-size: 15px; margin: 18px 0 8px; } h3 { font-size: 13px; margin: 14px 0 6px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  p { margin: 0 0 10px; } .muted { color: var(--muted); } .danger { color: var(--danger); }
  label { display: grid; gap: 4px; margin-bottom: 10px; }
  label.check { display: flex; gap: 8px; align-items: center; }
  input, select, textarea { font: inherit; padding: 6px 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: inherit; min-width: 0; }
  input[type="color"] { padding: 2px; height: 34px; width: 52px; }
  input[type="checkbox"] { width: auto; }
  textarea { min-height: 110px; font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
  button { font: inherit; padding: 6px 12px; border-radius: 8px; border: 1px solid transparent; background: var(--accent); color: #fff; cursor: pointer; }
  button.ghost { background: transparent; color: inherit; border-color: var(--line); }
  button.danger { background: transparent; color: var(--danger); border-color: currentColor; }
  button:disabled { opacity: .5; cursor: default; }
  .bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .bar .grow { flex: 1; }
  .grid { display: grid; gap: 0 14px; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); }
  .card { border: 1px solid var(--line); border-radius: 12px; padding: 14px; background: var(--card); margin-bottom: 12px; }
  .cols { display: grid; gap: 16px; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); }
  @media (max-width: 860px) { .cols { grid-template-columns: 1fr; } }
  .preview { border: 1px dashed var(--line); border-radius: 12px; padding: 12px; background: var(--soft); display: grid; gap: 12px; justify-items: center; overflow: auto; }
  .preview img { max-width: 100%; }
  .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); margin: 12px 0; }
  .tabs button { background: transparent; color: var(--muted); border: 0; border-bottom: 2px solid transparent; border-radius: 0; }
  .tabs button.active { color: var(--fg); border-bottom-color: var(--accent); }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  th { font-weight: 600; color: var(--muted); font-size: 12px; }
  tr.click { cursor: pointer; } tr.click:hover td { background: var(--soft); }
  .pill { font-size: 12px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); white-space: nowrap; }
  .pill.on { color: #15803d; border-color: currentColor; } .pill.off { color: var(--muted); }
  .snippet { display: grid; gap: 4px; margin-bottom: 12px; }
  .snippet textarea { min-height: 64px; }
  .swatches { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
  .swatch { display: grid; gap: 4px; justify-items: center; padding: 8px; border-radius: 10px; border: 2px solid var(--line); background: var(--card); color: inherit; }
  .swatch.active { border-color: var(--accent); }
  .swatch span { display: block; width: 64px; height: 22px; border-radius: 6px; }
  [hidden] { display: none !important; }
`;

/** `<base>` keeps the script, the API calls and the widget under `base_url`, wherever the app is hosted. */
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

export function campaignsPage(baseUrl: string): Response {
  return shell(
    baseUrl,
    'Timely',
    '    <main id="app"><p class="muted">…</p></main>',
    'campaigns.js',
  );
}

export function settingsPage(baseUrl: string): Response {
  return shell(
    baseUrl,
    'Timely settings',
    `    <p data-i18n="intro">Defaults for new campaigns. Each campaign can change them.</p>
    <form id="settings" class="grid">
      <label><span data-i18n="locale">Language of the timer labels</span>
        <select name="label_locale"><option value="it">Italiano</option><option value="en">English</option></select>
      </label>
      <label><span data-i18n="preset">Look</span>
        <select name="preset"><option value="classic">Classic</option><option value="minimal">Minimal</option><option value="bold">Bold</option><option value="neon">Neon</option><option value="soft">Soft</option></select>
      </label>
      <label><span data-i18n="duration">Evergreen duration (hours)</span><input name="duration_hours" type="number" min="1" max="8760" /></label>
    </form>
    <button type="button" id="save" data-i18n="save">Save</button>
    <p id="status" class="muted"></p>`,
    'settings.js',
  );
}
