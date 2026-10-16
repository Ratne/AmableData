/** Stylesheet of the widget's shadow root; `accent` comes from the event type color (validated hex). */
export function buildStyles(accent: string): string {
  const color = /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : '#4f46e5';
  return `
:host{display:block}
.ab{--ab-accent:${color};--ab-text:#111827;--ab-muted:#6b7280;--ab-border:#e5e7eb;--ab-bg:#fff;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ab-text);background:var(--ab-bg);border:1px solid var(--ab-border);border-radius:14px;max-width:880px;margin:0 auto;box-sizing:border-box;overflow:hidden}
.ab *{box-sizing:border-box}
.ab-head{padding:20px 24px;border-bottom:1px solid var(--ab-border)}
.ab-host{font-size:13px;color:var(--ab-muted);margin:0 0 4px}
.ab-title{font-size:20px;font-weight:650;margin:0}
.ab-meta{display:flex;flex-wrap:wrap;gap:12px;margin-top:8px;font-size:13px;color:var(--ab-muted)}
.ab-desc{margin:10px 0 0;font-size:14px;line-height:1.5;white-space:pre-line}
.ab-body{padding:20px 24px}
.ab-cols{display:grid;grid-template-columns:minmax(0,1fr) 220px;gap:24px}
@container (max-width:620px){.ab-cols{grid-template-columns:1fr}}
.ab-narrow .ab-cols{grid-template-columns:1fr}
.ab-step{font-size:15px;font-weight:600;margin:0 0 12px}
.ab-cal-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.ab-month{font-weight:600;text-transform:capitalize}
.ab-nav{border:0;background:transparent;font-size:20px;width:36px;height:36px;border-radius:999px;cursor:pointer;color:var(--ab-text)}
.ab-nav:disabled{opacity:.3;cursor:default}
.ab-nav:not(:disabled):hover{background:#f3f4f6}
.ab-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;text-align:center}
.ab-dow{font-size:11px;color:var(--ab-muted);text-transform:uppercase;padding:4px 0}
.ab-day{border:0;background:transparent;aspect-ratio:1;border-radius:999px;font-size:14px;color:#9ca3af;cursor:default}
.ab-day.avail{color:var(--ab-accent);font-weight:650;background:color-mix(in srgb,var(--ab-accent) 10%,transparent);cursor:pointer}
.ab-day.avail:hover{background:color-mix(in srgb,var(--ab-accent) 20%,transparent)}
.ab-day.sel{background:var(--ab-accent);color:#fff}
.ab-slots{display:flex;flex-direction:column;gap:8px;max-height:380px;overflow:auto}
.ab-slots-day{font-size:14px;font-weight:600;margin:0 0 4px;text-transform:capitalize}
.ab-slot{border:1px solid color-mix(in srgb,var(--ab-accent) 50%,transparent);color:var(--ab-accent);background:#fff;border-radius:8px;padding:10px;font-size:14px;font-weight:600;cursor:pointer}
.ab-slot:hover{border-color:var(--ab-accent)}
.ab-tz{margin-top:16px;display:flex;flex-direction:column;gap:4px;font-size:13px}
.ab-tz select,.ab-input,.ab-select,.ab-textarea{width:100%;border:1px solid var(--ab-border);border-radius:8px;padding:9px 10px;font:inherit;font-size:14px;color:var(--ab-text);background:#fff}
.ab-textarea{min-height:80px;resize:vertical}
.ab-input:focus,.ab-select:focus,.ab-textarea:focus{outline:2px solid color-mix(in srgb,var(--ab-accent) 40%,transparent);border-color:var(--ab-accent)}
.ab-field{display:flex;flex-direction:column;gap:4px;margin-bottom:12px}
.ab-label{font-size:13px;font-weight:600}
.ab-req{color:#dc2626}
.ab-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.ab-narrow .ab-row{grid-template-columns:1fr}
.ab-check{display:flex;gap:8px;align-items:center;font-size:14px;margin:2px 0}
.ab-ferr{font-size:12px;color:#dc2626}
.ab-err{background:#fef2f2;color:#991b1b;border-radius:8px;padding:10px 12px;font-size:13px;margin-bottom:12px}
.ab-picked{background:#f9fafb;border-radius:8px;padding:10px 12px;font-size:14px;margin-bottom:16px}
.ab-actions{display:flex;gap:8px;align-items:center;justify-content:space-between;margin-top:8px}
.ab-cta{border:0;background:var(--ab-accent);color:#fff;border-radius:8px;padding:11px 18px;font:inherit;font-weight:650;cursor:pointer}
.ab-cta:disabled{opacity:.6;cursor:default}
.ab-ghost{border:1px solid var(--ab-border);background:#fff;color:var(--ab-text);border-radius:8px;padding:10px 14px;font:inherit;cursor:pointer}
.ab-danger{background:#dc2626}
.ab-done{text-align:center;padding:36px 24px}
.ab-done-icon{width:48px;height:48px;border-radius:999px;background:color-mix(in srgb,var(--ab-accent) 15%,transparent);color:var(--ab-accent);display:inline-flex;align-items:center;justify-content:center;font-size:24px;margin-bottom:12px}
.ab-done h3{margin:0 0 8px;font-size:18px}
.ab-when{font-weight:600;margin:12px 0}
.ab-when::first-letter{text-transform:uppercase}
.ab-muted{color:var(--ab-muted);font-size:13px}
.ab-link{color:var(--ab-accent)}
`;
}
