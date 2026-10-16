/**
 * `srcdoc` frames inherit the SPA's CSP (`script-src 'nonce-…' 'strict-dynamic'`),
 * so the renderer's inline scripts only run when they carry the page nonce.
 * Without a nonce (vite dev, no CSP) the HTML is returned unchanged.
 */
function spaNonce(): string | null {
  const script = document.querySelector<HTMLScriptElement>('script[nonce]');
  const nonce = script?.nonce || script?.getAttribute('nonce') || '';
  return nonce === '' ? null : nonce;
}

export function withSpaNonce(html: string): string {
  const nonce = spaNonce();
  if (nonce === null) return html;
  return html.replace(/<script\b(?![^>]*\bnonce=)/gi, `<script nonce="${nonce}"`);
}

const UNSAFE_URL = /^\s*(javascript|vbscript|data:text\/html)/i;

/**
 * The editor canvas is a same-origin frame (drag & drop hit-tests its DOM), so
 * author markup inside widgets (html widget, embeds) must stay inert: scripts,
 * event handlers, `javascript:` URLs and srcdoc frames are dropped. Only the
 * renderer's own scripts (outside widgets) get the nonce.
 */
export function editorCanvasDocument(html: string): Document {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const nonce = spaNonce();
  for (const widget of parsed.querySelectorAll('[data-b-id]')) {
    for (const el of widget.querySelectorAll('script, object, embed, iframe[srcdoc], base, meta, link')) el.remove();
    for (const el of [widget, ...widget.querySelectorAll('*')]) {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on') || (['href', 'src', 'action', 'formaction', 'xlink:href'].includes(name) && UNSAFE_URL.test(attr.value))) {
          el.removeAttribute(attr.name);
        }
      }
    }
  }
  if (nonce !== null) for (const script of parsed.querySelectorAll('script')) script.setAttribute('nonce', nonce);
  return parsed;
}

export function serializeDocument(doc: Document): string {
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

/** Opens rendered HTML in a new tab (blob documents inherit the same CSP). */
export function openHtmlInNewTab(html: string): void {
  const url = URL.createObjectURL(new Blob([withSpaNonce(html)], { type: 'text/html' }));
  window.open(url, '_blank', 'noopener');
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
