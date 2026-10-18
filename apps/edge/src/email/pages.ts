/** Minimal hosted unsubscribe pages (no scripts, no external assets), English and Italian. */

export type PageLocale = 'en' | 'it';

const STRINGS = {
  en: {
    title: 'Unsubscribe',
    confirm: 'Do you want to stop receiving marketing emails at {email}?',
    button: 'Unsubscribe',
    done: 'You have been unsubscribed. You will not receive marketing emails at this address anymore.',
    already: 'This address is already unsubscribed.',
    invalid: 'This unsubscribe link is not valid or has expired.',
    test: 'This is a test email: the unsubscribe link does nothing.',
    error: 'Something went wrong. Please try again in a few minutes.',
    linkTitle: 'Link unavailable',
    linkInvalid: 'This link is not valid or has expired.',
  },
  it: {
    title: 'Disiscrizione',
    confirm: 'Vuoi smettere di ricevere email di marketing all’indirizzo {email}?',
    button: 'Disiscriviti',
    done: 'Disiscrizione completata. Non riceverai più email di marketing a questo indirizzo.',
    already: 'Questo indirizzo risulta già disiscritto.',
    invalid: 'Questo link di disiscrizione non è valido o è scaduto.',
    test: 'Questa è un’email di prova: il link di disiscrizione non ha effetto.',
    error: 'Qualcosa è andato storto. Riprova tra qualche minuto.',
    linkTitle: 'Link non disponibile',
    linkInvalid: 'Questo link non è valido o è scaduto.',
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
h1{font-size:1.25rem;margin:0 0 1rem}p{line-height:1.5;margin:0 0 1.5rem}
button{font:inherit;background:#111827;color:#fff;border:0;border-radius:8px;padding:.6rem 1.2rem;cursor:pointer}
@media (prefers-color-scheme:dark){body{background:#0b0d12;color:#e5e7eb}main{background:#151821}button{background:#e5e7eb;color:#111827}}
</style>
</head>
<body><main><h1>${title}</h1><p>${text}</p>${form}</main></body>
</html>`;
}
