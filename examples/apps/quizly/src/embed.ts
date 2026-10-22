/**
 * `<div data-quizly="<public id>"></div><script async src="<app>/embed.js"></script>`:
 * every such div of the page becomes an iframe with the quiz, as tall as its
 * content. The page's `email`, `c` and campaign parameters go along, so a
 * known contact is recognised; the result page opens in the embedding page.
 * Optional: `data-quizly-email` / `data-quizly-contact` set the contact.
 */

interface QuizlyWindow extends Window {
  __quizlyEmbed?: boolean;
}

(() => {
  const w = window as QuizlyWindow;
  if (w.__quizlyEmbed === true) return;
  w.__quizlyEmbed = true;

  const current = document.currentScript;
  const src =
    current instanceof HTMLScriptElement && current.src !== '' ? current.src : (document.querySelector<HTMLScriptElement>('script[src*="/embed.js"]')?.src ?? '');
  if (src === '') return;
  const base = src.replace(/\/embed\.js(?:[?#].*)?$/, '');
  const origin = new URL(base).origin;
  const FORWARD = /^(email|c|utm_[a-z_]+|gclid|fbclid|msclkid|ttclid)$/;
  const frames: HTMLIFrameElement[] = [];

  function mount(el: HTMLElement): void {
    el.setAttribute('data-quizly-mounted', '');
    const id = el.getAttribute('data-quizly') ?? '';
    if (!/^[0-9a-z]{16}$/.test(id)) return;
    const url = new URL(`${base}/q/${id}`);
    url.searchParams.set('embed', '1');
    for (const [key, value] of new URLSearchParams(location.search)) if (FORWARD.test(key)) url.searchParams.set(key, value);
    const email = el.getAttribute('data-quizly-email');
    const contact = el.getAttribute('data-quizly-contact');
    if (email !== null && email !== '') url.searchParams.set('email', email);
    if (contact !== null && contact !== '') url.searchParams.set('c', contact);
    const frame = document.createElement('iframe');
    frame.src = url.toString();
    frame.title = el.getAttribute('data-quizly-title') ?? 'Quiz';
    frame.loading = 'lazy';
    frame.setAttribute('allow', 'clipboard-write');
    frame.style.cssText = `display:block;width:100%;border:0;overflow:hidden;height:${el.getAttribute('data-quizly-height') ?? '520'}px;transition:height .2s ease`;
    el.replaceChildren(frame);
    frames.push(frame);
  }

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.origin !== origin) return;
    const frame = frames.find((f) => f.contentWindow === event.source);
    const data = event.data as { type?: unknown; height?: unknown; url?: unknown } | null;
    if (frame === undefined || data === null || typeof data !== 'object') return;
    if (data.type === 'quizly:height' && typeof data.height === 'number' && data.height > 0) {
      frame.style.height = `${String(Math.min(Math.ceil(data.height), 20_000))}px`;
    }
    if (data.type === 'quizly:redirect' && typeof data.url === 'string' && /^https?:\/\//i.test(data.url)) {
      (event.source as Window).postMessage({ type: 'quizly:redirect-ack' }, origin);
      window.location.assign(data.url);
    }
  });

  function scan(): void {
    for (const el of document.querySelectorAll<HTMLElement>('[data-quizly]:not([data-quizly-mounted])')) mount(el);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan);
  else scan();
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
})();
