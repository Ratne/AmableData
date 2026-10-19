import type { EsignLocale } from './types';

/** Signer-facing strings of the signing page (the SPA catalogs don't ship to signers). */
export interface SigningStrings {
  loading: string;
  notFound: string;
  loadError: string;
  networkError: string;
  genericError: string;
  consentChanged: string;
  rateLimited: string;
  requestFrom: string;
  signingAs: string;
  expiresOn: string;
  pageOf: string;
  waitingTitle: string;
  waitingText: string;
  signedTitle: string;
  signedText: string;
  completedTitle: string;
  completedText: string;
  declinedTitle: string;
  declinedText: string;
  closedDeclined: string;
  closedVoided: string;
  closedExpired: string;
  download: string;
  fieldsLeft: string;
  allFilled: string;
  nextField: string;
  finish: string;
  signing: string;
  required: string;
  optional: string;
  invalidNumber: string;
  invalidDate: string;
  chooseOption: string;
  fixFields: string;
  signatureTitle: string;
  initialsTitle: string;
  imageTitle: string;
  draw: string;
  type: string;
  upload: string;
  clear: string;
  apply: string;
  cancel: string;
  typeName: string;
  drawHint: string;
  uploadHint: string;
  imageTooLarge: string;
  edit: string;
  checked: string;
  otpTitle: string;
  otpText: string;
  otpSend: string;
  otpResend: string;
  otpResendIn: string;
  otpCode: string;
  otpVerify: string;
  otpInvalid: string;
  otpExpired: string;
  consentLabel: string;
  consentRequired: string;
  decline: string;
  declineTitle: string;
  declineText: string;
  declineReason: string;
  declineConfirm: string;
}

const en: SigningStrings = {
  loading: 'Loading…',
  notFound: 'This signing link is not valid.',
  loadError: 'The document could not be loaded.',
  networkError: 'Network error. Please check your connection and try again.',
  genericError: 'Something went wrong. Please try again.',
  consentChanged: 'The consent text was updated while this page was open. Reload the page to read it, then sign again.',
  rateLimited: 'Too many attempts. Please wait a moment and retry.',
  requestFrom: '{tenant} asks you to sign this document',
  signingAs: 'Signing as {name} · {party}',
  expiresOn: 'Sign before {date}',
  pageOf: 'Page {n} of {total}',
  waitingTitle: 'Not your turn yet',
  waitingText: 'Another party signs before you. We will email you as soon as it is your turn.',
  signedTitle: 'Thank you, you signed',
  signedText: 'We will email you the signed document once every party has signed.',
  completedTitle: 'Document signed',
  completedText: 'Every party signed this document. You can download the signed copy.',
  declinedTitle: 'You declined to sign',
  declinedText: 'The sender has been notified.',
  closedDeclined: 'This document can no longer be signed: a party declined it.',
  closedVoided: 'This document can no longer be signed: the sender cancelled it.',
  closedExpired: 'This document can no longer be signed: the signing period expired.',
  download: 'Download PDF',
  fieldsLeft: '{n} required fields left',
  allFilled: 'All required fields are filled',
  nextField: 'Next field',
  finish: 'Sign document',
  signing: 'Signing…',
  required: 'Required',
  optional: 'Optional',
  invalidNumber: 'Enter a number.',
  invalidDate: 'Enter a valid date.',
  chooseOption: 'Choose an option.',
  fixFields: 'Please complete the highlighted fields.',
  signatureTitle: 'Your signature',
  initialsTitle: 'Your initials',
  imageTitle: 'Image',
  draw: 'Draw',
  type: 'Type',
  upload: 'Upload',
  clear: 'Clear',
  apply: 'Apply',
  cancel: 'Cancel',
  typeName: 'Type your name',
  drawHint: 'Draw with your mouse, finger or stylus',
  uploadHint: 'PNG or JPEG image',
  imageTooLarge: 'The image is too large.',
  edit: 'Change',
  checked: 'Checked',
  otpTitle: 'Confirm your email',
  otpText: 'To sign, enter the 6-digit code we send to {email}.',
  otpSend: 'Send code',
  otpResend: 'Send a new code',
  otpResendIn: 'New code in {n}s',
  otpCode: 'Code',
  otpVerify: 'Confirm',
  otpInvalid: 'Wrong code. {n} attempts left.',
  otpExpired: 'The code expired or too many attempts were made. Request a new one.',
  consentLabel: 'I agree to sign electronically',
  consentRequired: 'Please accept to sign electronically.',
  decline: 'Decline',
  declineTitle: 'Decline to sign',
  declineText: 'The sender will be notified and nobody will be able to sign this document anymore.',
  declineReason: 'Reason (optional)',
  declineConfirm: 'Decline to sign',
};

const it: SigningStrings = {
  loading: 'Caricamento…',
  notFound: 'Questo link di firma non è valido.',
  loadError: 'Non è stato possibile caricare il documento.',
  networkError: 'Errore di rete. Controlla la connessione e riprova.',
  genericError: 'Qualcosa è andato storto. Riprova.',
  consentChanged: 'Il testo del consenso è stato aggiornato mentre la pagina era aperta. Ricarica la pagina per leggerlo, poi firma di nuovo.',
  rateLimited: 'Troppi tentativi. Attendi qualche istante e riprova.',
  requestFrom: '{tenant} ti chiede di firmare questo documento',
  signingAs: 'Firmi come {name} · {party}',
  expiresOn: 'Firma entro il {date}',
  pageOf: 'Pagina {n} di {total}',
  waitingTitle: 'Non è ancora il tuo turno',
  waitingText: 'Un’altra parte firma prima di te. Ti scriveremo appena tocca a te.',
  signedTitle: 'Grazie, hai firmato',
  signedText: 'Ti invieremo il documento firmato quando tutte le parti avranno firmato.',
  completedTitle: 'Documento firmato',
  completedText: 'Tutte le parti hanno firmato il documento. Puoi scaricare la copia firmata.',
  declinedTitle: 'Hai rifiutato di firmare',
  declinedText: 'Il mittente è stato avvisato.',
  closedDeclined: 'Questo documento non può più essere firmato: una delle parti ha rifiutato.',
  closedVoided: 'Questo documento non può più essere firmato: il mittente lo ha annullato.',
  closedExpired: 'Questo documento non può più essere firmato: il periodo per firmare è scaduto.',
  download: 'Scarica PDF',
  fieldsLeft: '{n} campi obbligatori da compilare',
  allFilled: 'Tutti i campi obbligatori sono compilati',
  nextField: 'Campo successivo',
  finish: 'Firma il documento',
  signing: 'Firma in corso…',
  required: 'Obbligatorio',
  optional: 'Facoltativo',
  invalidNumber: 'Inserisci un numero.',
  invalidDate: 'Inserisci una data valida.',
  chooseOption: 'Scegli un’opzione.',
  fixFields: 'Completa i campi evidenziati.',
  signatureTitle: 'La tua firma',
  initialsTitle: 'Le tue iniziali',
  imageTitle: 'Immagine',
  draw: 'Disegna',
  type: 'Scrivi',
  upload: 'Carica',
  clear: 'Cancella',
  apply: 'Applica',
  cancel: 'Annulla',
  typeName: 'Scrivi il tuo nome',
  drawHint: 'Disegna con mouse, dito o penna',
  uploadHint: 'Immagine PNG o JPEG',
  imageTooLarge: 'L’immagine è troppo grande.',
  edit: 'Modifica',
  checked: 'Selezionato',
  otpTitle: 'Conferma la tua email',
  otpText: 'Per firmare, inserisci il codice di 6 cifre che inviamo a {email}.',
  otpSend: 'Invia il codice',
  otpResend: 'Invia un nuovo codice',
  otpResendIn: 'Nuovo codice tra {n}s',
  otpCode: 'Codice',
  otpVerify: 'Conferma',
  otpInvalid: 'Codice errato. Tentativi rimasti: {n}.',
  otpExpired: 'Il codice è scaduto o hai fatto troppi tentativi. Richiedine uno nuovo.',
  consentLabel: 'Accetto di firmare elettronicamente',
  consentRequired: 'Accetta di firmare elettronicamente per continuare.',
  decline: 'Rifiuta',
  declineTitle: 'Rifiuta di firmare',
  declineText: 'Il mittente verrà avvisato e nessuno potrà più firmare questo documento.',
  declineReason: 'Motivo (facoltativo)',
  declineConfirm: 'Rifiuta di firmare',
};

export const SIGNING_STRINGS: Readonly<Record<EsignLocale, SigningStrings>> = { en, it };

export function fill(template: string, vars: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in vars ? String(vars[key]) : match,
  );
}
