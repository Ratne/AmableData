import type { EsignLocale } from './types';

/**
 * Electronic signature consent shown above the sign button. The version is
 * stored with the signature: change it whenever the text changes, so the
 * audit trail tells which wording the signer accepted.
 */
export const ESIGN_CONSENT_VERSION = '2026-10-2';

const TEXT: Record<EsignLocale, string> = {
  en:
    'I agree to sign this document with an electronic signature and to be bound by its contents. ' +
    'I consent to the recording of my email address, IP address, device and browser details and the time of each action ' +
    'as evidence of this signature.',
  it:
    'Accetto di firmare questo documento con firma elettronica e di essere vincolato al suo contenuto. ' +
    "Acconsento alla registrazione di indirizzo email, indirizzo IP, dati del dispositivo e del browser e dell'orario di ogni azione " +
    'come prova di questa firma.',
};

export function consentText(locale: EsignLocale): string {
  return TEXT[locale];
}

/** `auto` follows the visitor's preferred languages (Italian when listed first among en/it). */
export function resolveEsignLocale(setting: string, preferred: readonly string[]): EsignLocale {
  if (setting === 'en' || setting === 'it') return setting;
  for (const tag of preferred) {
    const lang = tag.toLowerCase().split('-')[0];
    if (lang === 'it') return 'it';
    if (lang === 'en') return 'en';
  }
  return 'en';
}
