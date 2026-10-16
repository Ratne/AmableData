import type { GeneralMessageKey } from './general-en';

/** Italian strings of Settings > General — must cover every key of general-en. */
export const generalIt: Readonly<Record<GeneralMessageKey, string>> = {
  'general.saved': 'Impostazioni salvate',
  'general.workspace.title': 'Spazio di lavoro',
  'general.workspace.name': 'Nome',
  'general.workspace.slug': 'Indirizzo',
  'general.workspace.slugHint': 'Lettere minuscole, numeri e trattini: {url}',
  'general.workspace.slugChange':
    'Il vecchio indirizzo "{old}" continuerà a funzionare: i link a form, pagine di prenotazione, landing page, snippet di tracciamento e integrazioni API non si rompono. Al salvataggio ti verrà chiesto il secondo fattore.',
  'general.workspace.previous': 'Indirizzi precedenti ancora attivi: {slugs}',
  'general.branding.title': 'Aspetto',
  'general.branding.intro':
    'Il tuo logo e il tuo colore sostituiscono quelli di amabledata in alto a sinistra e sui pulsanti, per tutti i membri di questo spazio.',
  'general.branding.logo': 'Logo',
  'general.branding.logoHint':
    'PNG, JPEG, WebP, GIF o AVIF, fino a 1 MB. Rendono meglio le immagini quadrate.',
  'general.branding.uploadLogo': 'Carica logo',
  'general.branding.replaceLogo': 'Sostituisci',
  'general.branding.removeLogo': 'Rimuovi',
  'general.branding.logoSaved': 'Logo aggiornato',
  'general.branding.logoTooLarge': 'Il logo supera 1 MB',
  'general.branding.color': 'Colore principale',
  'general.branding.colorHint':
    'Pulsanti, link ed evidenziazioni. Vuoto = il colore di amabledata.',
  'general.branding.resetColor': 'Colore predefinito',
  'general.regional.title': 'Impostazioni regionali',
  'general.regional.timezone': 'Fuso orario',
  'general.regional.timezoneHint':
    'Usato per gli invii programmati, le date nelle email e le automazioni.',
  'general.regional.language': 'Lingua dello spazio di lavoro',
  'general.regional.languageHint': 'Lingua degli inviti inviati ai nuovi utenti.',
  'general.regional.languageInviter': 'Lingua di chi invita',
  'general.regional.country': 'Paese predefinito',
  'general.regional.countryHint':
    'Preimpostato nei nuovi indirizzi e numeri di telefono. Vuoto = dedotto dalla lingua del browser.',
  'general.regional.currency': 'Valuta predefinita',
  'general.regional.currencyHint':
    'Dei nuovi prodotti e ordini (la stessa delle impostazioni e-commerce).',
  'general.company.title': 'Dati aziendali',
  'general.company.intro':
    'Chi gestisce questo spazio: dati pronti per fatture, piè di pagina delle email e documenti.',
  'general.company.legal_name': 'Ragione sociale',
  'general.company.vat_number': 'Partita IVA',
  'general.company.tax_code': 'Codice fiscale',
  'general.company.sdi_code': 'Codice destinatario SDI',
  'general.company.pec': 'PEC',
  'general.company.email': 'Email',
  'general.company.phone': 'Telefono',
  'general.company.website': 'Sito web',
  'general.company.address': 'Sede legale',
  'general.company.street': 'Via',
  'general.company.street_number': 'Civico',
  'general.company.postal_code': 'CAP',
  'general.company.city': 'Città',
  'general.company.region': 'Provincia / regione',
  'general.company.country_code': 'Paese',
  'general.error.nameRequired': 'Inserisci un nome',
  'general.error.slug':
    'Da 2 a 64 caratteri: lettere minuscole, numeri e trattini (non all’inizio o alla fine)',
  'general.error.color': 'Usa il formato #rrggbb',
  'general.error.email': 'Indirizzo email non valido',
  'general.error.sdi': '6 o 7 lettere o cifre',
  'general.error.website': 'Inizia con https://',
};
