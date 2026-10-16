import type { BillingMessageKey } from './billing-en';

/** Italian strings of Impostazioni > Fatturazione e wallet — must cover every key of billing-en. */
export const billingIt: Readonly<Record<BillingMessageKey, string>> = {
  'billing.title': 'Fatturazione e wallet',
  'billing.ownerOnly': 'Solo il proprietario del workspace può vedere fatturazione e wallet.',
  'billing.plan.title': 'Piano',
  'billing.plan.managed': 'Gestita',
  'billing.plan.managedPrice': '{price}/mese',
  'billing.plan.managedBody':
    'Installazione e aggiornamenti automatici, monitor errori e salute, servizi centrali, quota email inclusa e supporto. I consumi Cloudflare sono addebitati sul tuo account Cloudflare.',
  'billing.plan.openSource': 'Open source',
  'billing.plan.state': 'Servizio',
  'billing.plan.periodEnd': 'Rinnovo il',
  'billing.plan.unknownState': 'Non ancora disponibile',
  'billing.state.trial': 'Prova',
  'billing.state.active': 'Attivo',
  'billing.state.grace': 'Periodo di tolleranza',
  'billing.state.suspended': 'Sospeso',
  'billing.state.self_hosted': 'Self-hosted',
  'billing.state.graceBody':
    "L'ultimo pagamento non è andato a buon fine. Aggiorna il metodo di pagamento nel portale: finito il periodo di tolleranza si fermano aggiornamenti, email di sistema e servizi centrali. L'installazione e i dati non vengono mai toccati.",
  'billing.state.suspendedBody':
    "I servizi centrali sono fermi perché l'abbonamento non è pagato: gli invii email sono bloccati e gli aggiornamenti automatici in pausa. I tuoi dati restano disponibili. Regolarizza il pagamento nel portale per ripartire.",
  'billing.email.title': 'Quota email',
  'billing.email.used': '{used} di {included} email incluse usate',
  'billing.email.remaining': 'Rimanenti',
  'billing.email.period': 'Periodo',
  'billing.email.periodRange': '{start} – {end}',
  'billing.email.overage': 'Oltre la quota',
  'billing.email.overagePrice': '{price} ogni 1.000 email',
  'billing.email.caps': 'Limiti di invio',
  'billing.email.capsValue': "{hourly} all'ora, {daily} al giorno",
  'billing.email.noCap': 'nessun limite',
  'billing.email.explain':
    "La quota inclusa si azzera a ogni rinnovo. Oltre la quota le email si pagano dal wallet a {price} ogni 1.000. Prima che parta un broadcast se ne stima il costo: se il saldo non lo copre l'invio non parte; le email delle automazioni vanno in pausa a wallet vuoto e riprendono dopo la ricarica.",
  'billing.email.unavailable':
    'I dati della quota non sono ancora disponibili: compaiono dopo il primo contatto con la piattaforma.',
  'billing.wallet.title': 'Wallet',
  'billing.wallet.balance': 'Saldo disponibile',
  'billing.wallet.lowTitle': 'Saldo basso',
  'billing.wallet.low':
    'Il saldo non copre {count} email oltre la quota inclusa ({cost}). Ricarica per evitare broadcast bloccati ed email delle automazioni in pausa.',
  'billing.wallet.explain':
    'Credito prepagato per i consumi oltre il piano (email oltre la quota, in futuro le funzioni AI). Ricariche, auto-ricarica e fatture si gestiscono nel portale.',
  'billing.wallet.unavailable': 'Il saldo non è ancora disponibile.',
  'billing.wallet.topUp': 'Ricarica wallet',
  'billing.wallet.manage': 'Gestisci pagamenti e fatture',
  'billing.openSource.title': 'Installazione open source',
  'billing.openSource.body':
    'Questa installazione è self-hosted e gratuita: la installi e la aggiorni tu, con i tuoi provider email e le tue app OAuth. I servizi centrali (aggiornamenti gestiti, servizio email di sistema, app OAuth verificate, supporto) non sono inclusi.',
  'billing.openSource.connect':
    'Puoi collegare un account della piattaforma per comprare crediti per i servizi a pagamento, come in futuro i token AI per le analitiche.',
  'billing.openSource.connectButton': 'Collega un account',
  'billing.openSource.linked':
    'Questa installazione è collegata a un account della piattaforma: i servizi a pagamento sono addebitati sul wallet qui sotto.',
  'billing.stale.title': 'I dati potrebbero non essere aggiornati',
  'billing.stale.body':
    'Al momento la piattaforma non è raggiungibile. Ultimo aggiornamento: {date}.',
  'billing.missing.body':
    'La piattaforma non ha ancora inviato i dati di quota e wallet. Nel frattempo gli invii non vengono bloccati.',
};
