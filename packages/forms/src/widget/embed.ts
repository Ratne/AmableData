/** Bootstrap shared by the embed scripts (`/forms.js`, `/booking.js`): shadow roots, errors, scanning. */

const MOUNTED = 'data-amable-mounted';

/** Origin the embed script was loaded from; call it while the script runs (`currentScript`). */
export function scriptOrigin(): string {
  const current = document.currentScript;
  const src = current instanceof HTMLScriptElement ? current.src : '';
  if (src !== '' && !src.startsWith('blob:')) {
    try {
      return new URL(src).origin;
    } catch {
      // fall through
    }
  }
  return location.origin;
}

export function shadowOf(el: HTMLElement): ShadowRoot {
  return el.shadowRoot ?? el.attachShadow({ mode: 'open' });
}

/** The `<style>` and the render box (marked by `boxAttribute`) of the element's shadow root. */
export function shadowBox(el: HTMLElement, css: string, boxAttribute: string): HTMLElement {
  const root = shadowOf(el);
  let style = root.querySelector('style');
  if (style === null) {
    style = document.createElement('style');
    root.appendChild(style);
  }
  style.textContent = css;
  let box = root.querySelector<HTMLElement>(`div[${boxAttribute}]`);
  if (box === null) {
    box = document.createElement('div');
    box.setAttribute(boxAttribute, '');
    root.appendChild(box);
  }
  return box;
}

/** Replaces the element's shadow content with an error line. */
export function showMessage(el: HTMLElement, text: string): void {
  const root = shadowOf(el);
  root.innerHTML = '';
  const p = document.createElement('p');
  p.textContent = text;
  p.style.cssText = 'font-family:system-ui,sans-serif;color:#b91c1c;font-size:14px';
  root.appendChild(p);
}

/** Calls `mount` once for every element matching `selector` that was not mounted yet. */
export function mountEach(selector: string, mount: (el: HTMLElement) => void): void {
  for (const el of document.querySelectorAll<HTMLElement>(selector)) {
    if (el.hasAttribute(MOUNTED)) continue;
    el.setAttribute(MOUNTED, '');
    mount(el);
  }
}

/** Runs `scan` once the document is parsed and again whenever nodes are added. */
export function startScanning(scan: () => void): void {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan);
  else scan();
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
}
