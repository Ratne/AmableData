/** Styles of the signing page (injected once; the page has no other stylesheet). */
export const STYLES = `
.sg{--accent:#4f46e5;--accent-soft:#eef2ff;--danger:#dc2626;--muted:#6b7280;--line:#e5e7eb;font-size:15px;line-height:1.45;color:#111827;padding-bottom:96px}
.sg *{box-sizing:border-box}
.sg button{font:inherit;cursor:pointer}
.sg-head{background:#fff;border-bottom:1px solid var(--line);padding:16px 20px}
.sg-head-in{max-width:960px;margin:0 auto;display:flex;gap:16px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.sg-title{font-size:18px;font-weight:650;margin:0}
.sg-sub{color:var(--muted);font-size:13px;margin:2px 0 0}
.sg-main{max-width:960px;margin:20px auto;padding:0 12px}
.sg-note{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:16px;white-space:pre-wrap}
.sg-banner{border-radius:12px;padding:16px 18px;margin-bottom:16px;background:var(--accent-soft);border:1px solid #c7d2fe}
.sg-banner.ok{background:#ecfdf5;border-color:#a7f3d0}
.sg-banner.bad{background:#fef2f2;border-color:#fecaca}
.sg-banner h2{margin:0 0 4px;font-size:16px}
.sg-banner p{margin:0}
.sg-page{position:relative;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.12);margin:0 auto 18px;user-select:none}
.sg-page img.sg-bg{display:block;width:100%;height:100%;pointer-events:none}
.sg-page-n{position:absolute;right:8px;bottom:-16px;font-size:11px;color:var(--muted)}
.sg-f{position:absolute;border:1.5px dashed var(--accent);background:rgba(79,70,229,.08);border-radius:3px;display:flex;align-items:center;justify-content:center;overflow:hidden}
.sg-f.req::after{content:'*';position:absolute;top:-2px;right:2px;color:var(--danger);font-size:12px}
.sg-f.filled{border-style:solid;background:rgba(79,70,229,.03)}
.sg-f.err{border-color:var(--danger);background:rgba(220,38,38,.08)}
.sg-f.focus{box-shadow:0 0 0 3px rgba(79,70,229,.35)}
.sg-f input[type=text],.sg-f input[type=date],.sg-f select{width:100%;height:100%;border:0;background:transparent;padding:0 4px;font:inherit;color:#111827;outline:none}
.sg-f input[type=checkbox]{width:70%;height:70%;margin:0;accent-color:var(--accent)}
.sg-f .sg-radio{display:flex;flex-wrap:wrap;gap:2px 8px;padding:0 4px;width:100%;align-items:center}
.sg-f .sg-radio label{display:flex;gap:3px;align-items:center;white-space:nowrap}
.sg-f button.sg-pick{width:100%;height:100%;border:0;background:transparent;color:var(--accent);font-weight:600;padding:0 4px;display:flex;align-items:center;justify-content:center}
.sg-f img.sg-val{max-width:100%;max-height:100%;object-fit:contain}
.sg-f.other{border:1px dotted #9ca3af;background:rgba(156,163,175,.08);color:#374151;pointer-events:none;justify-content:flex-start;padding:0 4px;white-space:nowrap}
.sg-f.other.filled{background:transparent;border-color:transparent}
.sg-bar{position:fixed;left:0;right:0;bottom:0;background:#fff;border-top:1px solid var(--line);padding:10px 16px;z-index:10}
.sg-bar-in{max-width:960px;margin:0 auto;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.sg-progress{flex:1;min-width:160px;font-size:13px;color:var(--muted)}
.sg-consent{display:flex;gap:8px;align-items:flex-start;font-size:12px;color:#374151;flex-basis:100%}
.sg-consent input{margin-top:3px;accent-color:var(--accent)}
.sg-btn{border:1px solid var(--line);background:#fff;color:#111827;border-radius:9px;padding:9px 16px;font-weight:600}
.sg-btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.sg-btn.danger{color:var(--danger)}
.sg-btn:disabled{opacity:.55;cursor:default}
.sg-err{color:var(--danger);font-size:13px;margin:6px 0 0}
.sg-modal{position:fixed;inset:0;background:rgba(17,24,39,.55);display:flex;align-items:center;justify-content:center;z-index:20;padding:12px}
.sg-dialog{background:#fff;border-radius:14px;width:100%;max-width:560px;padding:18px;box-shadow:0 20px 50px rgba(0,0,0,.25)}
.sg-dialog h3{margin:0 0 10px;font-size:17px}
.sg-tabs{display:flex;gap:6px;margin-bottom:10px}
.sg-tabs button{border:1px solid var(--line);background:#fff;border-radius:8px;padding:6px 12px}
.sg-tabs button.on{background:var(--accent-soft);border-color:#c7d2fe;color:var(--accent);font-weight:600}
.sg-pad{width:100%;height:200px;border:1px solid var(--line);border-radius:10px;touch-action:none;background:#fafafa;display:block}
.sg-typed{width:100%;font-size:18px;padding:10px;border:1px solid var(--line);border-radius:10px}
.sg-preview{height:120px;border:1px solid var(--line);border-radius:10px;margin-top:10px;display:flex;align-items:center;justify-content:center;background:#fafafa;overflow:hidden}
.sg-preview img{max-height:100%;max-width:100%}
.sg-hint{color:var(--muted);font-size:12px;margin:6px 0 0}
.sg-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
.sg-code{font-size:26px;letter-spacing:8px;text-align:center;width:100%;padding:10px;border:1px solid var(--line);border-radius:10px}
.sg-dialog textarea{width:100%;min-height:90px;border:1px solid var(--line);border-radius:10px;padding:8px;font:inherit}
@media (max-width:640px){.sg-main{padding:0 4px}.sg-head{padding:12px}}
`;
