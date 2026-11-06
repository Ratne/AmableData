/** Visitor-facing strings of the checkout widget, the offer block and the hosted pages. */
export interface CheckoutStrings {
  contactTitle: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  company: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  postalCode: string;
  region: string;
  country: string;
  detailsTitle: string;
  paymentTitle: string;
  summaryTitle: string;
  chooseOne: string;
  chooseAny: string;
  pickAtLeastOne: string;
  quantity: string;
  subtotal: string;
  discount: string;
  tax: string;
  total: string;
  dueToday: string;
  setupFee: string;
  trial: string;
  then: string;
  every: Record<'day' | 'week' | 'month' | 'year', [string, string]>;
  discountedRenewals: string;
  discountedForever: string;
  promoPlaceholder: string;
  promoApply: string;
  promoRemove: string;
  promoApplied: string;
  pay: string;
  start: string;
  paying: string;
  terms: string;
  termsRequired: string;
  bumpAdd: string;
  success: string;
  orderNumber: string;
  genericError: string;
  networkError: string;
  notFound: string;
  loadError: string;
  domainNotAllowed: string;
  stripeMissing: string;
  previewNotice: string;
  fixErrors: string;
  paymentFailed: string;
  processing: string;
  offerAccept: string;
  offerDecline: string;
  offerProcessing: string;
  offerExpired: string;
  oneClickNote: string;
  redirecting: string;
  methodCard: string;
  methodBankTransfer: string;
  bankTransferNote: string;
  placeOrder: string;
  bankPending: string;
  bankHolder: string;
  bankIban: string;
  bankBic: string;
  bankName: string;
  bankReference: string;
  bankAmount: string;
  bankEmailNote: string;
  offerBankNote: string;
  redirectNote: string;
  copy: string;
  copied: string;
  summarySubject: string;
  summaryIntro: string;
  summaryOrders: string;
  summaryOutro: string;
}

const en: CheckoutStrings = {
  contactTitle: 'Your details',
  email: 'Email',
  firstName: 'First name',
  lastName: 'Last name',
  phone: 'Phone',
  company: 'Company',
  addressLine1: 'Address',
  addressLine2: 'Apartment, suite (optional)',
  city: 'City',
  postalCode: 'Postal code',
  region: 'Province / State',
  country: 'Country',
  detailsTitle: 'Additional information',
  paymentTitle: 'Payment',
  summaryTitle: 'Order summary',
  chooseOne: 'Choose an option',
  chooseAny: 'Choose what to buy',
  pickAtLeastOne: 'Pick at least one item.',
  quantity: 'Qty',
  subtotal: 'Subtotal',
  discount: 'Discount',
  tax: 'Tax',
  total: 'Total',
  dueToday: 'Due today',
  setupFee: 'Setup fee',
  trial: '{n}-day free trial',
  then: 'then {amount} {every}',
  every: {
    day: ['every day', 'every {n} days'],
    week: ['every week', 'every {n} weeks'],
    month: ['every month', 'every {n} months'],
    year: ['every year', 'every {n} years'],
  },
  discountedRenewals: '{amount} for the next {n} renewals',
  discountedForever: 'discount applies to every renewal',
  promoPlaceholder: 'Discount code',
  promoApply: 'Apply',
  promoRemove: 'Remove',
  promoApplied: 'Code {code} applied',
  pay: 'Pay {amount}',
  start: 'Start subscription',
  paying: 'Processing…',
  terms: 'I accept the terms and conditions',
  termsRequired: 'Please accept the terms to continue.',
  bumpAdd: 'Yes, add it to my order',
  success: 'Thank you! Your payment was received.',
  orderNumber: 'Order {number}',
  genericError: 'Something went wrong. Please try again.',
  networkError: 'Network error. Please check your connection and try again.',
  notFound: 'This checkout is not available.',
  loadError: 'The checkout could not be loaded.',
  domainNotAllowed: 'This checkout cannot be used on this website.',
  stripeMissing: 'Payments are not configured yet.',
  previewNotice: 'Preview — payments are disabled.',
  fixErrors: 'Please check the highlighted fields.',
  paymentFailed: 'The payment did not go through. Please try another method.',
  processing: 'Your payment is being processed. You will receive a confirmation shortly.',
  offerAccept: 'Yes, add it — {amount}',
  offerDecline: 'No thanks',
  offerProcessing: 'Adding to your order…',
  offerExpired: 'This offer is no longer available.',
  oneClickNote: 'Charged to the payment method you just used. No need to enter it again.',
  redirecting: 'Redirecting…',
  methodCard: 'Card',
  methodBankTransfer: 'Bank transfer',
  bankTransferNote: 'You will get the bank details after placing the order. It is shipped once the transfer arrives.',
  placeOrder: 'Place order — {amount}',
  bankPending: 'Thank you! Your order is placed: complete it with a bank transfer.',
  bankHolder: 'Account holder',
  bankIban: 'IBAN',
  bankBic: 'BIC / SWIFT',
  bankName: 'Bank',
  bankReference: 'Payment reference',
  bankAmount: 'Amount',
  bankEmailNote: 'We also sent these details to your email.',
  offerBankNote: 'Nothing is charged now: it is added to the bank transfer to make.',
  redirectNote: 'You will complete the payment on Stripe.',
  copy: 'Copy',
  copied: 'Copied',
  summarySubject: 'Bank transfer details for order {reference}',
  summaryIntro: 'Thank you for your order. To complete it, please make a bank transfer with these details.',
  summaryOrders: 'Orders',
  summaryOutro: 'The order is confirmed as soon as the transfer arrives.',
};

const it: CheckoutStrings = {
  contactTitle: 'I tuoi dati',
  email: 'Email',
  firstName: 'Nome',
  lastName: 'Cognome',
  phone: 'Telefono',
  company: 'Azienda',
  addressLine1: 'Indirizzo',
  addressLine2: 'Interno, scala (facoltativo)',
  city: 'Città',
  postalCode: 'CAP',
  region: 'Provincia',
  country: 'Paese',
  detailsTitle: 'Informazioni aggiuntive',
  paymentTitle: 'Pagamento',
  summaryTitle: 'Riepilogo ordine',
  chooseOne: 'Scegli un’opzione',
  chooseAny: 'Scegli cosa acquistare',
  pickAtLeastOne: 'Seleziona almeno un prodotto.',
  quantity: 'Q.tà',
  subtotal: 'Subtotale',
  discount: 'Sconto',
  tax: 'IVA',
  total: 'Totale',
  dueToday: 'Da pagare oggi',
  setupFee: 'Costo di attivazione',
  trial: 'Prova gratuita di {n} giorni',
  then: 'poi {amount} {every}',
  every: {
    day: ['al giorno', 'ogni {n} giorni'],
    week: ['a settimana', 'ogni {n} settimane'],
    month: ['al mese', 'ogni {n} mesi'],
    year: ['all’anno', 'ogni {n} anni'],
  },
  discountedRenewals: '{amount} per i prossimi {n} rinnovi',
  discountedForever: 'lo sconto vale su ogni rinnovo',
  promoPlaceholder: 'Codice sconto',
  promoApply: 'Applica',
  promoRemove: 'Rimuovi',
  promoApplied: 'Codice {code} applicato',
  pay: 'Paga {amount}',
  start: 'Attiva abbonamento',
  paying: 'Elaborazione…',
  terms: 'Accetto i termini e le condizioni',
  termsRequired: 'Accetta i termini per continuare.',
  bumpAdd: 'Sì, aggiungilo al mio ordine',
  success: 'Grazie! Abbiamo ricevuto il tuo pagamento.',
  orderNumber: 'Ordine {number}',
  genericError: 'Si è verificato un errore. Riprova.',
  networkError: 'Errore di rete. Controlla la connessione e riprova.',
  notFound: 'Questo checkout non è disponibile.',
  loadError: 'Impossibile caricare il checkout.',
  domainNotAllowed: 'Questo checkout non può essere usato su questo sito.',
  stripeMissing: 'I pagamenti non sono ancora configurati.',
  previewNotice: 'Anteprima — i pagamenti sono disattivati.',
  fixErrors: 'Controlla i campi evidenziati.',
  paymentFailed: 'Il pagamento non è andato a buon fine. Prova un altro metodo.',
  processing: 'Il pagamento è in elaborazione. Riceverai a breve una conferma.',
  offerAccept: 'Sì, aggiungilo — {amount}',
  offerDecline: 'No, grazie',
  offerProcessing: 'Aggiunta all’ordine…',
  offerExpired: 'Questa offerta non è più disponibile.',
  oneClickNote: 'Addebitato sul metodo di pagamento appena usato, senza reinserirlo.',
  redirecting: 'Reindirizzamento…',
  methodCard: 'Carta',
  methodBankTransfer: 'Bonifico bancario',
  bankTransferNote: 'Riceverai le coordinate bancarie dopo aver confermato l’ordine. L’ordine viene evaso all’arrivo del bonifico.',
  placeOrder: 'Conferma ordine — {amount}',
  bankPending: 'Grazie! Il tuo ordine è confermato: completalo con un bonifico.',
  bankHolder: 'Intestatario',
  bankIban: 'IBAN',
  bankBic: 'BIC / SWIFT',
  bankName: 'Banca',
  bankReference: 'Causale',
  bankAmount: 'Importo',
  bankEmailNote: 'Ti abbiamo inviato queste coordinate anche via email.',
  offerBankNote: 'Nessun addebito ora: viene aggiunto al bonifico da effettuare.',
  redirectNote: 'Completerai il pagamento su Stripe.',
  copy: 'Copia',
  copied: 'Copiato',
  summarySubject: 'Coordinate per il bonifico dell’ordine {reference}',
  summaryIntro: 'Grazie per il tuo ordine. Per completarlo effettua un bonifico con queste coordinate.',
  summaryOrders: 'Ordini',
  summaryOutro: 'L’ordine viene confermato appena riceviamo il bonifico.',
};

export type CheckoutLocale = 'en' | 'it';

export const CHECKOUT_STRINGS: Readonly<Record<CheckoutLocale, CheckoutStrings>> = { en, it };

export function resolveCheckoutLocale(setting: string, preferred: readonly string[]): CheckoutLocale {
  if (setting === 'en' || setting === 'it') return setting;
  for (const tag of preferred) {
    const base = tag.toLowerCase().split('-')[0];
    if (base === 'it' || base === 'en') return base;
  }
  return 'en';
}

export function formatMoney(minor: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''));
}

export function everyLabel(
  strings: CheckoutStrings,
  interval: keyof CheckoutStrings['every'],
  count: number,
): string {
  const [one, many] = strings.every[interval];
  return count === 1 ? one : fill(many, { n: count });
}
