import type { CheckoutMessageKey } from './checkout-en';

/** Italian checkout builder strings — must cover every key of checkout-en.ts. */
export const checkoutIt: Readonly<Record<CheckoutMessageKey, string>> = {
  'nav.checkouts': 'Checkout',

  'checkout.status.draft': 'Bozza',
  'checkout.status.active': 'Attivo',
  'checkout.status.archived': 'Archiviato',
  'checkout.status.notArchived': 'Bozze e attivi',

  'checkout.list.new': 'Nuovo checkout',
  'checkout.list.create': 'Crea checkout',
  'checkout.list.empty':
    'Nessun checkout. Creane uno per vendere prodotti e piani dalle tue landing page.',
  'checkout.list.nameHint': "Nome interno, mostrato come origine dell'ordine.",
  'checkout.list.duplicated': 'Checkout duplicato',
  'checkout.list.content': '{items} articoli · {bumps} bump · {offers} offerte',
  'checkout.action.duplicate': 'Duplica',
  'checkout.action.moveUp': 'Sposta su',
  'checkout.action.moveDown': 'Sposta giù',

  'checkout.field.paid': 'Ordini pagati',
  'checkout.field.revenue': 'Incasso',
  'checkout.field.content': 'Contenuto',
  'checkout.field.updated': 'Aggiornato',
  'checkout.field.price': 'Prezzo',
  'checkout.field.catalogPrice': 'Prezzo di listino: {price}',
  'checkout.field.priceCatalog': 'Prezzo di listino',
  'checkout.field.label': 'Etichetta',
  'checkout.field.labelHint': 'Vuoto usa il nome del catalogo.',
  'checkout.field.imageUrl': "URL dell'immagine",

  'checkout.tab.products': 'Prodotti',
  'checkout.tab.fields': 'Campi',
  'checkout.tab.bumps': 'Bump',
  'checkout.tab.offers': 'Post-acquisto',
  'checkout.tab.design': 'Design',
  'checkout.tab.settings': 'Impostazioni',

  'checkout.items.addProduct': 'Aggiungi prodotto',
  'checkout.items.addPlan': 'Aggiungi piano',
  'checkout.items.selection': "Scelta dell'acquirente",
  'checkout.items.selection.all': 'Compra tutto',
  'checkout.items.selection.one': 'Scegli uno',
  'checkout.items.selection.all.hint': 'Tutti gli articoli vengono acquistati insieme.',
  'checkout.items.selection.one.hint':
    "L'acquirente sceglie un articolo (es. piano mensile o annuale).",
  'checkout.items.allowQuantity': "Permetti all'acquirente di cambiare le quantità",
  'checkout.items.empty': 'Aggiungi almeno un prodotto o un piano.',
  'checkout.items.kind.product': 'Prodotto',
  'checkout.items.kind.plan': 'Piano',
  'checkout.items.preselected': 'Preselezionato',
  'checkout.items.selection.any': 'Scegli quali',
  'checkout.items.selection.any.hint':
    "L'acquirente spunta gli articoli da acquistare (uno o più).",
  'checkout.items.checked': "Spuntato all'apertura della pagina",

  'checkout.discounts.title': 'Sconti automatici',
  'checkout.discounts.intro':
    'Sconti applicati da soli quando il carrello contiene i prodotti indicati con almeno la loro quantità (es. A + B: 10% di sconto; 2 × A + 1 × B: 15%). Se più regole sono valide vince lo sconto maggiore.',
  'checkout.discounts.add': 'Aggiungi sconto',
  'checkout.discounts.defaultLabel': 'Sconto pacchetto',
  'checkout.discounts.stackPromo':
    'I codici promo si sommano agli sconti automatici (disattivato: un codice valido li sostituisce)',
  'checkout.discounts.label': 'Etichetta',
  'checkout.discounts.labelHint': "Mostrata nel riepilogo dell'ordine.",
  'checkout.discounts.kind': 'Sconto',
  'checkout.discounts.kind.percent': 'Percentuale',
  'checkout.discounts.kind.fixed': 'Importo fisso',
  'checkout.discounts.percent': 'Percentuale (%)',
  'checkout.discounts.amount': 'Importo',
  'checkout.discounts.scope': 'Scontati',
  'checkout.discounts.scope.matching': 'I prodotti indicati',
  'checkout.discounts.scope.order': "Tutto l'ordine",
  'checkout.discounts.scope.matching.hint': 'Vengono scontati solo i prodotti delle condizioni.',
  'checkout.discounts.scope.order.hint':
    "Viene scontato ogni prodotto dell'ordine, bump compresi (mai i piani in abbonamento).",
  'checkout.discounts.conditions': 'Quando il carrello contiene',
  'checkout.discounts.minQuantity': 'Quantità min.',
  'checkout.discounts.addCondition': 'Aggiungi prodotto',

  'checkout.bumps.add': 'Aggiungi bump',
  'checkout.bumps.intro':
    "Gli order bump sono prodotti extra che l'acquirente aggiunge con una spunta, direttamente nel checkout.",
  'checkout.bumps.defaultTitle': "Sì, aggiungilo all'ordine",
  'checkout.bumps.title': 'Titolo',
  'checkout.bumps.skin': 'Stile',
  'checkout.bumps.skin.classic': 'Classico',
  'checkout.bumps.skin.highlight': 'Evidenziato',
  'checkout.bumps.skin.dashed': 'Tratteggiato',
  'checkout.bumps.skin.minimal': 'Minimale',
  'checkout.bumps.skin.ribbon': 'Nastro',
  'checkout.bumps.position': 'Posizione',
  'checkout.bumps.position.below_items': 'Sotto i prodotti',
  'checkout.bumps.position.above_payment': 'Sopra il pagamento',
  'checkout.bumps.position.below_payment': 'Sotto il pagamento',
  'checkout.bumps.color': 'Colore di accento',
  'checkout.bumps.colorHint': 'Vuoto usa il colore del checkout.',
  'checkout.bumps.checked': 'Spuntato di default',

  'checkout.offers.addUpsell': 'Aggiungi upsell',
  'checkout.offers.addDownsell': 'Aggiungi downsell',
  'checkout.offers.intro':
    "Dopo il pagamento l'acquirente vede queste offerte una alla volta: accettando addebiti la carta salvata con un clic, senza reinserirla. Ogni risposta porta all'offerta successiva o alla pagina di ringraziamento.",
  'checkout.offers.first': 'Prima offerta',
  'checkout.offers.firstHint': 'Mostrata subito dopo il pagamento.',
  'checkout.offers.none': 'Nessuna (vai alla pagina di ringraziamento)',
  'checkout.offers.window': 'Tempo per accettare (minuti)',
  'checkout.offers.windowHint': 'Dopo questo tempo il link one-click scade.',
  'checkout.offers.kind': 'Tipo',
  'checkout.offers.kind.upsell': 'Upsell',
  'checkout.offers.kind.downsell': 'Downsell',
  'checkout.offers.itemKind': 'Cosa vende',
  'checkout.offers.pageUrl': "URL della pagina dell'offerta",
  'checkout.offers.pageUrlHint':
    "Una landing page con il blocco offerta. Vuoto usa la pagina dell'offerta integrata.",
  'checkout.offers.onAccept': 'Se accetta',
  'checkout.offers.onDecline': 'Se rifiuta',
  'checkout.offers.thankYou': 'Pagina di ringraziamento',
  'checkout.offers.defaultUpsell': 'Offerta speciale',
  'checkout.offers.defaultDownsell': 'Ultima occasione',

  'checkout.contact.title': "Dati dell'acquirente",
  'checkout.contact.name': 'Nome',
  'checkout.contact.phone': 'Telefono',
  'checkout.contact.company': 'Azienda',
  'checkout.contact.address': 'Indirizzo di fatturazione',
  'checkout.contact.mode.required': 'Obbligatorio',
  'checkout.contact.mode.optional': 'Facoltativo',
  'checkout.contact.mode.hidden': 'Nascosto',
  'checkout.contact.defaultCountry': 'Paese predefinito',
  'checkout.contact.autocomplete': 'Completamento automatico indirizzo',
  'checkout.contact.emailAlways': "L'email è sempre obbligatoria: identifica il contatto nel CRM.",
  'checkout.fields.custom': 'Campi personalizzati',
  'checkout.fields.prefillHint':
    "Ogni campo viene precompilato dal parametro dell'URL della pagina con lo stesso nome (es. ?email=…). I parametri UTM sono sempre salvati sull'ordine.",

  'checkout.design.layout': 'Layout',
  'checkout.design.layout.two_columns': 'Due colonne',
  'checkout.design.layout.one_column': 'Una colonna',
  'checkout.design.summaryBackground': 'Sfondo del riepilogo',

  'checkout.settings.purchase': 'Acquisto',
  'checkout.payments.title': 'Metodi di pagamento',
  'checkout.payments.card': 'Carta (Stripe)',
  'checkout.payments.bankTransfer': 'Bonifico bancario',
  'checkout.payments.account': 'Conto bancario',
  'checkout.payments.pickAccount': 'Scegli un conto',
  'checkout.payments.bankHint':
    "L'ordine viene creato \"In attesa di pagamento\" e l'acquirente riceve queste coordinate nella pagina e via email. Diventa pagato quando registri il pagamento sull'ordine. Gli upsell accettati dopo l'acquisto si sommano allo stesso bonifico.",
  'checkout.payments.noAccounts':
    'Nessun conto bancario: aggiungine uno nelle impostazioni E-commerce.',
  'checkout.payments.plansCardOnly':
    'Gli abbonamenti si rinnovano su una carta salvata: con un piano nel carrello viene offerta solo la carta e gli upsell di piani vengono saltati per chi paga con bonifico.',
  'checkout.payments.methods': 'Metodi di pagamento Stripe',
  'checkout.payments.methods.automatic': 'Automatici',
  'checkout.payments.methods.custom': 'Solo quelli selezionati',
  'checkout.payments.methods.automaticHint':
    'Tutti i metodi attivi nella dashboard Stripe compatibili con valuta e importo.',
  'checkout.payments.methods.customHint':
    "La carta c'è sempre. Gli altri compaiono solo se sono attivi anche nella dashboard Stripe e compatibili con valuta e importo.",
  'checkout.payments.method.card': 'Carta',
  'checkout.payments.method.link': 'Link (checkout veloce)',
  'checkout.payments.method.paypal': 'PayPal',
  'checkout.payments.method.klarna': 'Klarna',
  'checkout.payments.method.bancontact': 'Bancontact',
  'checkout.payments.method.ideal': 'iDEAL',
  'checkout.payments.method.eps': 'EPS',
  'checkout.payments.method.sepa_debit': 'Addebito diretto SEPA',
  'checkout.payments.method.revolut_pay': 'Revolut Pay',
  'checkout.payments.method.amazon_pay': 'Amazon Pay',
  'checkout.payments.methodsDropped':
    'Con un abbonamento o le offerte post-acquisto il metodo viene salvato per gli addebiti successivi: {methods} non si può salvare e non viene offerto.',
  'checkout.payments.wallets': 'Apple Pay e Google Pay',
  'checkout.payments.walletsHint':
    'Compaiono sui dispositivi con una carta nel wallet, sui domini registrati in Stripe (avviene in automatico la prima volta che il checkout si carica su un dominio).',
  'checkout.payments.managedMethods':
    'Stripe Managed Payments è attivo: il pagamento con carta passa da Stripe Checkout, che sceglie da sé i metodi.',
  'checkout.abandoned.title': 'Carrello abbandonato',
  'checkout.abandoned.enabled': 'Salva l’email appena il cliente la scrive',
  'checkout.abandoned.delay': 'Abbandonato dopo',
  'checkout.abandoned.delayHint':
    'Senza acquisto in questo tempo il contatto viene creato o aggiornato e parte il trigger.',
  'checkout.abandoned.minutes': '{n} minuti',
  'checkout.abandoned.hours': '{n} h',
  'checkout.abandoned.days': '{n} g',
  'checkout.abandoned.hint':
    'Avvia un recupero con il trigger di automazione "Carrello abbandonato". Nell’email metti il link alla pagina del checkout aggiungendo ?email={{ contact.email }}: il cliente trova l’email già compilata.',
  'checkout.abandoned.privacy':
    'L’email viene raccolta prima dell’acquisto: indicalo nella privacy policy. I carrelli salvati vengono cancellati dopo 30 giorni.',
  'checkout.settings.heading': 'Titolo',
  'checkout.settings.button_label': 'Pulsante di pagamento',
  'checkout.settings.success_message': 'Messaggio di conferma',
  'checkout.settings.terms_label': 'Testo della spunta dei termini',
  'checkout.settings.defaultHint': "Vuoto usa il testo predefinito nella lingua dell'acquirente.",
  'checkout.settings.promoCodes': 'Accetta codici promo',
  'checkout.settings.promoParam': "Parametro dell'URL",
  'checkout.settings.promoParamHint':
    'Un link con ?{param}=CODICE applica il codice in automatico.',
  'checkout.settings.thankYouUrl': 'URL della pagina di ringraziamento',
  'checkout.settings.thankYouHint': 'Vuoto mostra il messaggio di conferma sul posto.',
  'checkout.settings.termsUrl': 'URL dei termini',
  'checkout.settings.termsHint': "Se impostato, l'acquirente deve accettare i termini per pagare.",
  'checkout.settings.hosted': 'Pagina ospitata (un link che funziona senza landing page)',
  'checkout.settings.tagsHint':
    "Aggiunti solo a pagamento riuscito (una carta rifiutata non ne aggiunge). Il contatto, il suo owner e la lead source vengono salvati appena l'acquirente invia il modulo.",
  'checkout.settings.attribution':
    'Gli ordini conservano i parametri UTM e il referrer della pagina, e il contatto viene collegato al checkout come origine.',

  'checkout.editor.saved': 'Salvato',
  'checkout.editor.noItems': 'Un checkout attivo senza prodotti non può essere acquistato.',

  'checkout.preview.title': 'Anteprima',
  'checkout.preview.unavailable': "Impossibile caricare l'anteprima.",

  'checkout.embed.title': 'Incorpora',
  'checkout.embed.snippet': 'Snippet del checkout',
  'checkout.embed.offerSnippet': "Snippet dell'offerta",
  'checkout.embed.offerHint':
    'Incollalo nella pagina di ogni upsell o downsell: mostra l’offerta con i pulsanti accetta e rifiuta.',
  'checkout.embed.hosted': 'Pagina ospitata',
  'checkout.embed.open': 'Apri',
  'checkout.embed.unsaved': 'Salva per pubblicare le ultime modifiche.',
  'checkout.embed.landingHint':
    "Nell'editor delle landing page usa i blocchi Checkout e Offerta checkout: nessun codice necessario.",
};
