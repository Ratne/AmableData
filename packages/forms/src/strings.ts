import type { FieldErrorCode } from './validate';

/** Visitor-facing strings of the widget and the hosted page (the SPA catalogs don't ship to customer sites). */
export interface WidgetStrings {
  submit: string;
  submitting: string;
  next: string;
  back: string;
  step: string;
  success: string;
  select: string;
  fixErrors: string;
  genericError: string;
  networkError: string;
  turnstileFailed: string;
  domainNotAllowed: string;
  notFound: string;
  loadError: string;
  previewNotice: string;
  fieldErrors: Record<FieldErrorCode, string>;
}

const en: WidgetStrings = {
  submit: 'Submit',
  submitting: 'Sending…',
  next: 'Next',
  back: 'Back',
  step: 'Step {n} of {total}',
  success: 'Thank you! Your submission has been received.',
  select: 'Select…',
  fixErrors: 'Please check the highlighted fields.',
  genericError: 'Something went wrong. Please try again.',
  networkError: 'Network error. Please check your connection and try again.',
  turnstileFailed: 'The anti-spam check failed. Please try again.',
  domainNotAllowed: 'This form cannot be used on this website.',
  notFound: 'This form is not available.',
  loadError: 'The form could not be loaded.',
  previewNotice: 'Preview — submissions are disabled.',
  fieldErrors: {
    required: 'This field is required.',
    invalid_email: 'Enter a valid email address.',
    invalid_phone: 'Enter a valid phone number.',
    invalid_number: 'Enter a number.',
    too_small: 'The value is too small.',
    too_large: 'The value is too large.',
    too_long: 'The text is too long.',
    invalid_date: 'Enter a valid date.',
    invalid_option: 'Choose one of the options.',
    invalid_value: 'The value is not valid.',
  },
};

const it: WidgetStrings = {
  submit: 'Invia',
  submitting: 'Invio in corso…',
  next: 'Avanti',
  back: 'Indietro',
  step: 'Passo {n} di {total}',
  success: 'Grazie! Abbiamo ricevuto la tua richiesta.',
  select: 'Seleziona…',
  fixErrors: 'Controlla i campi evidenziati.',
  genericError: 'Si è verificato un errore. Riprova.',
  networkError: 'Errore di rete. Controlla la connessione e riprova.',
  turnstileFailed: 'La verifica anti-spam non è riuscita. Riprova.',
  domainNotAllowed: 'Questo form non può essere usato su questo sito.',
  notFound: 'Questo form non è disponibile.',
  loadError: 'Impossibile caricare il form.',
  previewNotice: 'Anteprima — l’invio è disattivato.',
  fieldErrors: {
    required: 'Campo obbligatorio.',
    invalid_email: 'Inserisci un indirizzo email valido.',
    invalid_phone: 'Inserisci un numero di telefono valido.',
    invalid_number: 'Inserisci un numero.',
    too_small: 'Il valore è troppo basso.',
    too_large: 'Il valore è troppo alto.',
    too_long: 'Il testo è troppo lungo.',
    invalid_date: 'Inserisci una data valida.',
    invalid_option: 'Scegli una delle opzioni.',
    invalid_value: 'Il valore non è valido.',
  },
};

export type WidgetLocale = 'en' | 'it';

export const WIDGET_STRINGS: Readonly<Record<WidgetLocale, WidgetStrings>> = { en, it };

/** Locale of the form: explicit setting, else the first supported browser / Accept-Language tag. */
export function resolveWidgetLocale(setting: string, preferred: readonly string[]): WidgetLocale {
  if (setting === 'en' || setting === 'it') return setting;
  for (const tag of preferred) {
    const base = tag.trim().slice(0, 2).toLowerCase();
    if (base === 'it' || base === 'en') return base;
  }
  return 'en';
}

/** Languages of an Accept-Language header, by preference. */
export function acceptLanguageTags(header: string | null): string[] {
  if (header === null) return [];
  return header
    .split(',')
    .map((part) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.find((p) => p.trim().startsWith('q='));
      return { tag: tag.trim(), q: q === undefined ? 1 : Number(q.trim().slice(2)) || 0 };
    })
    .filter((entry) => entry.tag !== '')
    .sort((a, b) => b.q - a.q)
    .map((entry) => entry.tag);
}
