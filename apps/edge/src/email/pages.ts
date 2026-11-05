/** Minimal hosted recipient pages (no scripts, no external assets), English and Italian. */

export type PageLocale = 'en' | 'it';

const STRINGS = {
  en: {
    title: 'Unsubscribe',
    confirm: 'Do you want to stop receiving our emails at {email}?',
    button: 'Unsubscribe',
    done: 'You have been unsubscribed. You will not receive our emails at this address anymore.',
    already: 'This address is already unsubscribed.',
    invalid: 'This unsubscribe link is not valid or has expired.',
    test: 'This is a test email: the unsubscribe link does nothing.',
    error: 'Something went wrong. Please try again in a few minutes.',
    linkTitle: 'Link unavailable',
    linkInvalid: 'This link is not valid or has expired.',
    prefsTitle: 'Email preferences',
    trackingTitle: 'Open tracking',
    trackingOn: 'We record when you open our emails, through an invisible image.',
    trackingOff: 'We do not record when you open our emails.',
    trackingDisable: 'Turn off open tracking',
    trackingEnable: 'Turn open tracking back on',
    saved: 'Your preference has been saved.',
  },
  it: {
    title: 'Disiscrizione',
    confirm: 'Vuoi smettere di ricevere le nostre email all’indirizzo {email}?',
    button: 'Disiscriviti',
    done: 'Disiscrizione completata. Non riceverai più le nostre email a questo indirizzo.',
    already: 'Questo indirizzo risulta già disiscritto.',
    invalid: 'Questo link di disiscrizione non è valido o è scaduto.',
    test: 'Questa è un’email di prova: il link di disiscrizione non ha effetto.',
    error: 'Qualcosa è andato storto. Riprova tra qualche minuto.',
    linkTitle: 'Link non disponibile',
    linkInvalid: 'Questo link non è valido o è scaduto.',
    prefsTitle: 'Preferenze email',
    trackingTitle: 'Tracciamento aperture',
    trackingOn: 'Registriamo quando apri le nostre email, tramite un’immagine invisibile.',
    trackingOff: 'Non registriamo quando apri le nostre email.',
    trackingDisable: 'Disattiva il tracciamento',
    trackingEnable: 'Riattiva il tracciamento',
    saved: 'Preferenza salvata.',
  },
} as const;

export type PageMessage = keyof (typeof STRINGS)['en'];

export function pageLocale(acceptLanguage: string | undefined): PageLocale {
  const first = (acceptLanguage ?? '').split(',')[0]?.trim().toLowerCase() ?? '';
  return first.startsWith('it') ? 'it' : 'en';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function pageText(locale: PageLocale, key: PageMessage, email = ''): string {
  return STRINGS[locale][key].replace('{email}', email);
}

/** Shown by the click redirect when its token does not resolve to a destination. */
export function renderLinkErrorPage(locale: PageLocale): string {
  return renderUnsubscribePage(locale, { message: 'linkInvalid', title: 'linkTitle' });
}

function htmlDocument(locale: PageLocale, title: string, body: string): string {
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f7f9;color:#111827}
main{max-width:28rem;margin:12vh auto;padding:2rem;background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h1{font-size:1.25rem;margin:0 0 1rem}h2{font-size:1rem;margin:0 0 .5rem}p{line-height:1.5;margin:0 0 1.5rem}
section+section{border-top:1px solid #e5e7eb;padding-top:1.5rem;margin-top:1.5rem}
.notice{background:#ecfdf5;color:#065f46;border-radius:8px;padding:.6rem .9rem}
button{font:inherit;background:#111827;color:#fff;border:0;border-radius:8px;padding:.6rem 1.2rem;cursor:pointer}
button.secondary{background:transparent;color:inherit;border:1px solid #d1d5db}
@media (prefers-color-scheme:dark){body{background:#0b0d12;color:#e5e7eb}main{background:#151821}button{background:#e5e7eb;color:#111827}button.secondary{background:transparent;color:inherit;border-color:#374151}section+section{border-color:#262a35}.notice{background:#064e3b;color:#d1fae5}}
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export function renderUnsubscribePage(
  locale: PageLocale,
  input: { message: PageMessage; email?: string | null; form?: boolean; title?: PageMessage },
): string {
  const s = STRINGS[locale];
  const title = escapeHtml(s[input.title ?? 'title']);
  const text = escapeHtml(pageText(locale, input.message, input.email ?? ''));
  const form = input.form
    ? `<form method="post"><input type="hidden" name="confirm" value="1"><button type="submit">${escapeHtml(s.button)}</button></form>`
    : '';
  return htmlDocument(locale, title, `<h1>${title}</h1><p>${text}</p>${form}`);
}

/**
 * The recipient's personal page (the `{{ unsubscribe_url }}` of every email):
 * unsubscribe from all emails, and turn open tracking off or back on.
 */
export function renderPreferencesPage(
  locale: PageLocale,
  input: { email: string; unsubscribed: boolean; trackingOptedOut: boolean; notice?: PageMessage },
): string {
  const s = STRINGS[locale];
  const title = escapeHtml(s.prefsTitle);
  const notice = input.notice === undefined ? '' : `<p class="notice" role="status">${escapeHtml(s[input.notice])}</p>`;
  const unsubscribe = input.unsubscribed
    ? `<p>${escapeHtml(s.already)}</p>`
    : `<p>${escapeHtml(pageText(locale, 'confirm', input.email))}</p>` +
      `<form method="post"><input type="hidden" name="confirm" value="1"><button type="submit">${escapeHtml(s.button)}</button></form>`;
  const tracking =
    `<p>${escapeHtml(input.trackingOptedOut ? s.trackingOff : s.trackingOn)}</p>` +
    `<form method="post"><input type="hidden" name="tracking" value="${input.trackingOptedOut ? 'on' : 'off'}">` +
    `<button type="submit" class="secondary">${escapeHtml(input.trackingOptedOut ? s.trackingEnable : s.trackingDisable)}</button></form>`;
  return htmlDocument(
    locale,
    title,
    `<h1>${title}</h1>${notice}` +
      `<section><h2>${escapeHtml(s.title)}</h2>${unsubscribe}</section>` +
      `<section><h2>${escapeHtml(s.trackingTitle)}</h2>${tracking}</section>`,
  );
}
