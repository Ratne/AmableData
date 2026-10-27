import type { BookingLocale, SlotRejection } from './types';
import type { AnswerError } from './validate';

/** Visitor-facing strings of the widget and the hosted pages (the SPA catalogs don't ship to customer sites). */
export interface BookingWidgetStrings {
  loading: string;
  notFound: string;
  loadError: string;
  pickDate: string;
  pickTime: string;
  noSlots: string;
  noSlotsMonth: string;
  timeZone: string;
  duration: string;
  minutes: string;
  previousMonth: string;
  nextMonth: string;
  back: string;
  next: string;
  givenName: string;
  familyName: string;
  email: string;
  phone: string;
  select: string;
  confirm: string;
  confirming: string;
  confirmedTitle: string;
  confirmedText: string;
  addToCalendarHint: string;
  manageLink: string;
  slotTaken: string;
  networkError: string;
  genericError: string;
  fixErrors: string;
  turnstileFailed: string;
  rateLimited: string;
  manageTitle: string;
  cancelledTitle: string;
  cancelledText: string;
  cancel: string;
  cancelReason: string;
  cancelConfirm: string;
  reschedule: string;
  rescheduledTitle: string;
  pastBooking: string;
  /** The event type does not let the invitee change the booking. */
  changeDisabled: string;
  weekdaysShort: [string, string, string, string, string, string, string];
  rejections: Record<SlotRejection, string>;
  fieldErrors: Record<AnswerError, string>;
}

const en: BookingWidgetStrings = {
  loading: 'Loading…',
  notFound: 'This booking page is not available.',
  loadError: 'The booking page could not be loaded.',
  pickDate: 'Select a date',
  pickTime: 'Select a time',
  noSlots: 'No times available on this day.',
  noSlotsMonth: 'No availability this month.',
  timeZone: 'Time zone',
  duration: 'Duration',
  minutes: '{n} min',
  previousMonth: 'Previous month',
  nextMonth: 'Next month',
  back: 'Back',
  next: 'Next',
  givenName: 'First name',
  familyName: 'Last name',
  email: 'Email',
  phone: 'Phone',
  select: 'Select…',
  confirm: 'Confirm booking',
  confirming: 'Confirming…',
  confirmedTitle: 'You are booked',
  confirmedText: 'A confirmation email is on its way.',
  addToCalendarHint: 'You can cancel or reschedule from the link in the email.',
  manageLink: 'Manage this booking',
  slotTaken: 'This time was just taken. Please pick another one.',
  networkError: 'Network error. Please check your connection and try again.',
  genericError: 'Something went wrong. Please try again.',
  fixErrors: 'Please check the highlighted fields.',
  turnstileFailed: 'The anti-spam check failed. Please try again.',
  rateLimited: 'Too many attempts. Please wait a moment and retry.',
  manageTitle: 'Your booking',
  cancelledTitle: 'Booking cancelled',
  cancelledText: 'This booking has been cancelled.',
  cancel: 'Cancel booking',
  cancelReason: 'Reason (optional)',
  cancelConfirm: 'Yes, cancel it',
  reschedule: 'Reschedule',
  rescheduledTitle: 'Booking rescheduled',
  pastBooking: 'This booking can no longer be changed.',
  changeDisabled: 'To change this booking, please contact the host.',
  weekdaysShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  rejections: {
    no_hosts: 'This event has no available host.',
    too_soon: 'This time is too close. Please pick a later one.',
    too_far: 'This time is too far in the future.',
    out_of_schedule: 'This time is not available.',
    daily_limit: 'No more bookings are possible on this day.',
    slot_taken: 'This time was just taken. Please pick another one.',
  },
  fieldErrors: {
    required: 'This field is required.',
    invalid_email: 'Enter a valid email address.',
    invalid_phone: 'Enter a valid phone number.',
    invalid_number: 'Enter a number.',
    invalid_option: 'Choose one of the options.',
    too_long: 'The text is too long.',
    invalid_value: 'The value is not valid.',
  },
};

const it: BookingWidgetStrings = {
  loading: 'Caricamento…',
  notFound: 'Questa pagina di prenotazione non è disponibile.',
  loadError: 'Non è stato possibile caricare la pagina di prenotazione.',
  pickDate: 'Scegli una data',
  pickTime: 'Scegli un orario',
  noSlots: 'Nessun orario disponibile in questo giorno.',
  noSlotsMonth: 'Nessuna disponibilità in questo mese.',
  timeZone: 'Fuso orario',
  duration: 'Durata',
  minutes: '{n} min',
  previousMonth: 'Mese precedente',
  nextMonth: 'Mese successivo',
  back: 'Indietro',
  next: 'Avanti',
  givenName: 'Nome',
  familyName: 'Cognome',
  email: 'Email',
  phone: 'Telefono',
  select: 'Seleziona…',
  confirm: 'Conferma prenotazione',
  confirming: 'Conferma in corso…',
  confirmedTitle: 'Prenotazione confermata',
  confirmedText: 'Ti abbiamo inviato una email di conferma.',
  addToCalendarHint: 'Puoi annullare o spostare l’appuntamento dal link nella email.',
  manageLink: 'Gestisci la prenotazione',
  slotTaken: 'Questo orario è appena stato prenotato. Scegline un altro.',
  networkError: 'Errore di rete. Controlla la connessione e riprova.',
  genericError: 'Qualcosa è andato storto. Riprova.',
  fixErrors: 'Controlla i campi evidenziati.',
  turnstileFailed: 'Il controllo anti-spam non è riuscito. Riprova.',
  rateLimited: 'Troppi tentativi. Attendi qualche istante e riprova.',
  manageTitle: 'La tua prenotazione',
  cancelledTitle: 'Prenotazione annullata',
  cancelledText: 'Questa prenotazione è stata annullata.',
  cancel: 'Annulla prenotazione',
  cancelReason: 'Motivo (facoltativo)',
  cancelConfirm: 'Sì, annulla',
  reschedule: 'Sposta',
  rescheduledTitle: 'Prenotazione spostata',
  pastBooking: 'Questa prenotazione non può più essere modificata.',
  changeDisabled: "Per modificare questa prenotazione contatta l'organizzatore.",
  weekdaysShort: ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'],
  rejections: {
    no_hosts: 'Nessun organizzatore disponibile per questo evento.',
    too_soon: 'Questo orario è troppo vicino. Scegline uno successivo.',
    too_far: 'Questo orario è troppo lontano nel tempo.',
    out_of_schedule: 'Questo orario non è disponibile.',
    daily_limit: 'Non sono possibili altre prenotazioni in questo giorno.',
    slot_taken: 'Questo orario è appena stato prenotato. Scegline un altro.',
  },
  fieldErrors: {
    required: 'Campo obbligatorio.',
    invalid_email: 'Inserisci un indirizzo email valido.',
    invalid_phone: 'Inserisci un numero di telefono valido.',
    invalid_number: 'Inserisci un numero.',
    invalid_option: 'Scegli una delle opzioni.',
    too_long: 'Il testo è troppo lungo.',
    invalid_value: 'Il valore non è valido.',
  },
};

export const BOOKING_WIDGET_STRINGS: Readonly<Record<BookingLocale, BookingWidgetStrings>> = { en, it };

/** `auto` follows the visitor's preferred languages (Italian when listed first among en/it). */
export function resolveBookingLocale(setting: string, preferred: readonly string[]): BookingLocale {
  if (setting === 'en' || setting === 'it') return setting;
  for (const tag of preferred) {
    const lang = tag.toLowerCase().split('-')[0];
    if (lang === 'it') return 'it';
    if (lang === 'en') return 'en';
  }
  return 'en';
}

/** Language tags of an Accept-Language header, by preference. */
export function acceptLanguageList(header: string | null): string[] {
  if (header === null || header === '') return [];
  return header
    .split(',')
    .map((part) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.find((p) => p.trim().startsWith('q='));
      return { tag: tag.trim(), q: q === undefined ? 1 : Number(q.trim().slice(2)) || 0 };
    })
    .filter((entry) => entry.tag !== '' && entry.tag !== '*')
    .sort((a, b) => b.q - a.q)
    .map((entry) => entry.tag);
}
