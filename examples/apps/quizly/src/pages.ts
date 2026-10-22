import type { PublicQuiz, QuizStyle } from './quiz';

/** Screen shell of the builder (logic in quizzes-screen.ts) and the public quiz page (logic in player.ts). */

const STYLE = `
  :root { color-scheme: light; --fg: #111827; --muted: #6b7280; --line: #e5e7eb; --card: #ffffff; --soft: #f9fafb; --accent: #7c3aed; --danger: #b91c1c; --ok: #15803d; }
  body.dark { color-scheme: dark; --fg: #f3f4f6; --muted: #9ca3af; --line: #374151; --card: #111827; --soft: #1f2937; --accent: #a78bfa; --danger: #f87171; --ok: #4ade80; }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 16px; color: var(--fg); background: transparent; }
  h1 { font-size: 18px; margin: 0; } h2 { font-size: 15px; margin: 18px 0 8px; } h3 { font-size: 13px; margin: 14px 0 6px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  p { margin: 0 0 10px; } .muted { color: var(--muted); } .danger { color: var(--danger); } .small { font-size: 12px; }
  label { display: grid; gap: 4px; margin-bottom: 10px; }
  label.check { display: flex; gap: 8px; align-items: center; }
  input, select, textarea { font: inherit; padding: 6px 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: inherit; min-width: 0; width: 100%; }
  input[type="color"] { padding: 2px; height: 34px; width: 52px; }
  input[type="checkbox"] { width: auto; }
  textarea { min-height: 70px; }
  textarea.code { min-height: 64px; font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
  button { font: inherit; padding: 6px 12px; border-radius: 8px; border: 1px solid transparent; background: var(--accent); color: #fff; cursor: pointer; white-space: nowrap; }
  button.ghost { background: transparent; color: inherit; border-color: var(--line); }
  button.danger { background: transparent; color: var(--danger); border-color: currentColor; }
  button.icon { padding: 4px 8px; background: transparent; color: var(--muted); border-color: var(--line); }
  button:disabled { opacity: .5; cursor: default; }
  .bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .bar .grow { flex: 1; }
  .grid { display: grid; gap: 0 14px; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); }
  .card { border: 1px solid var(--line); border-radius: 12px; padding: 14px; background: var(--card); margin-bottom: 12px; }
  .step { border-left: 4px solid var(--accent); }
  .step.optin { border-left-color: #f59e0b; }
  .step-head { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
  .step-head .n { font-weight: 700; color: var(--accent); min-width: 28px; }
  .answers { display: grid; gap: 6px; margin: 8px 0; }
  .answer { display: grid; gap: 6px; grid-template-columns: minmax(0, 2fr) 72px minmax(0, 1.4fr) minmax(0, 1.2fr) auto; align-items: center; }
  .answer-head { font-size: 12px; color: var(--muted); }
  @media (max-width: 760px) { .answer { grid-template-columns: 1fr 1fr; } }
  .range { display: grid; gap: 6px; grid-template-columns: 72px 72px minmax(0, 1.2fr) minmax(0, 1.6fr) minmax(0, 1fr) auto; align-items: center; margin-bottom: 6px; }
  @media (max-width: 760px) { .range { grid-template-columns: 1fr 1fr; } }
  .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); margin: 12px 0; flex-wrap: wrap; }
  .tabs button { background: transparent; color: var(--muted); border: 0; border-bottom: 2px solid transparent; border-radius: 0; }
  .tabs button.active { color: var(--fg); border-bottom-color: var(--accent); }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-weight: 600; color: var(--muted); font-size: 12px; }
  tr.click { cursor: pointer; } tr.click:hover td { background: var(--soft); }
  .pill { font-size: 12px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); white-space: nowrap; }
  .pill.on { color: var(--ok); border-color: currentColor; } .pill.off { color: var(--muted); }
  .snippet { display: grid; gap: 4px; margin-bottom: 12px; }
  .meter { height: 8px; border-radius: 999px; background: var(--soft); overflow: hidden; min-width: 80px; }
  .meter span { display: block; height: 100%; background: var(--accent); }
  .warn { border: 1px solid #f59e0b; background: rgba(245, 158, 11, .08); border-radius: 10px; padding: 8px 12px; margin-bottom: 10px; }
  .kpis { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); margin-bottom: 12px; }
  .kpi { border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; }
  .kpi b { display: block; font-size: 22px; }
  [hidden] { display: none !important; }
`;

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
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

export function quizzesPage(baseUrl: string): Response {
  return shell(baseUrl, 'Quizly', '    <main id="app"><p class="muted">…</p></main>', 'quizzes.js');
}

/* ---------- public quiz page ---------- */

const esc = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const FONTS: Record<QuizStyle['font'], string> = {
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  rounded: 'ui-rounded, "SF Pro Rounded", "Nunito", system-ui, sans-serif',
};

/** The quiz look; `custom_css` comes last so it can override everything. */
export function playerCss(style: QuizStyle, embed: boolean): string {
  return `
  :root { --qz-accent: ${style.accent}; --qz-bg: ${style.background}; --qz-card: ${style.card}; --qz-text: ${style.text}; --qz-radius: ${String(style.radius)}px; }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body { font: 16px/1.5 ${FONTS[style.font]}; color: var(--qz-text); background: ${embed ? 'transparent' : 'var(--qz-bg)'}; }
  .qz { max-width: 680px; margin: 0 auto; padding: ${embed ? '8px' : 'clamp(16px, 5vw, 48px) 16px'}; }
  .qz-card { background: var(--qz-card); border-radius: var(--qz-radius); padding: clamp(20px, 4vw, 36px); box-shadow: 0 10px 30px rgba(17, 24, 39, .08); }
  .qz-progress { height: 6px; border-radius: 999px; background: color-mix(in srgb, var(--qz-accent) 15%, transparent); overflow: hidden; margin-bottom: 22px; }
  .qz-progress span { display: block; height: 100%; width: 0; background: var(--qz-accent); transition: width .35s ease; }
  .qz-title { font-size: clamp(20px, 3.4vw, 26px); line-height: 1.25; margin: 0 0 8px; }
  .qz-desc { margin: 0 0 18px; opacity: .8; white-space: pre-line; }
  .qz-image { display: block; max-width: 100%; max-height: 320px; margin: 0 auto 18px; border-radius: calc(var(--qz-radius) * .7); }
  .qz-answers { display: grid; gap: 10px; }
  .qz-answers.images { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
  .qz-answer { font: inherit; text-align: left; width: 100%; padding: 14px 16px; border-radius: calc(var(--qz-radius) * .7); border: 2px solid color-mix(in srgb, var(--qz-text) 12%, transparent); background: transparent; color: inherit; cursor: pointer; display: grid; gap: 8px; transition: border-color .15s, background .15s, transform .1s; }
  .qz-answer:hover, .qz-answer:focus-visible { border-color: var(--qz-accent); outline: none; }
  .qz-answer:active { transform: scale(.99); }
  .qz-answer.selected { border-color: var(--qz-accent); background: color-mix(in srgb, var(--qz-accent) 10%, transparent); }
  .qz-answer img { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; border-radius: calc(var(--qz-radius) * .5); }
  .qz-input { font: inherit; width: 100%; padding: 12px 14px; border-radius: calc(var(--qz-radius) * .7); border: 2px solid color-mix(in srgb, var(--qz-text) 15%, transparent); background: transparent; color: inherit; }
  textarea.qz-input { min-height: 120px; resize: vertical; }
  .qz-input:focus { border-color: var(--qz-accent); outline: none; }
  .qz-actions { display: flex; gap: 10px; align-items: center; margin-top: 20px; }
  .qz-actions .grow { flex: 1; }
  .qz-button { font: inherit; font-weight: 600; padding: 12px 22px; border-radius: calc(var(--qz-radius) * .7); border: 0; background: var(--qz-accent); color: #fff; cursor: pointer; }
  .qz-button:disabled { opacity: .5; cursor: default; }
  .qz-link { font: inherit; background: none; border: 0; color: inherit; opacity: .7; cursor: pointer; padding: 8px 4px; }
  .qz-link:hover { opacity: 1; }
  .qz-error { color: #b91c1c; margin-top: 10px; }
  .qz-result { text-align: center; }
  .qz-result .qz-title { font-size: clamp(22px, 4vw, 30px); }
  .qz-preview { font-size: 12px; text-align: center; opacity: .7; margin-bottom: 10px; }
  .qz-fade { animation: qz-in .3s ease both; }
  @keyframes qz-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .qz-fade { animation: none; } .qz-progress span { transition: none; } }
  ${style.custom_css}`;
}

/** Inline JSON safe inside `<script>`. */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function playerPage(baseUrl: string, quiz: PublicQuiz, embed: boolean): Response {
  const css = playerCss(quiz.style, embed).replace(/<\//g, '<\\/');
  const html = `<!doctype html>
<html lang="${quiz.settings.locale}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${esc(quiz.name)}</title>
    <style>${css}</style>
  </head>
  <body>
    <main class="qz" id="quizly"></main>
    <script type="application/json" id="quizly-data">${scriptJson({ quiz, base_url: baseUrl, embed })}</script>
    <script src="${baseUrl}/player.js"></script>
  </body>
</html>`;
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'strict-origin-when-cross-origin' },
  });
}

export function messagePage(title: string, text: string, status: number): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title></head><body style="font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;color:#333;margin:0"><p>${esc(text)}</p></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  );
}
