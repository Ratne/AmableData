import type { OpsMessageKey } from './ops-en';

/** Italian strings of the operations page — must cover every key of ops-en. */
export const opsIt: Readonly<Record<OpsMessageKey, string>> = {
  'nav.operations': 'Operatività',
  'ops.title': 'Operatività',
  'ops.intro':
    'Cosa è bloccato o in ritardo in questo workspace, e come recuperarlo. Aggiornata ogni minuto.',
  'ops.never': 'mai',
  'ops.forbidden': 'Solo gli admin del workspace vedono la pagina operatività.',
  'ops.registry.title': 'Anagrafica contatti',
  'ops.registry.empty': 'Nessun messaggio in sospeso',
  'ops.registry.parked': '{n} messaggi in sospeso dopo i tentativi',
  'ops.registry.parkedMore': 'Più di {n} messaggi in sospeso dopo i tentativi',
  'ops.registry.hint':
    'Lead e identità che non sono arrivati ai contatti (il più vecchio: {at}). Rigiocali dopo aver risolto la causa: un nuovo invio non crea doppioni.',
  'ops.registry.replay': 'Rigioca',
  'ops.registry.replayed': '{n} messaggi rigiocati',
  'ops.registry.replayedMore': '{n} messaggi rigiocati, ne restano altri: rigioca di nuovo',
  'ops.registry.failedAgain':
    '{n} falliti di nuovo, restano parcheggiati (vedi i log degli errori)',
  'ops.sites.title': 'Tracking',
  'ops.sites.empty': 'Nessun sito.',
  'ops.sites.site': 'Sito',
  'ops.sites.lastEvent': 'Ultimo evento',
  'ops.sites.pending': 'In attesa di replay',
  'ops.sites.stale': 'Da controllare',
  'ops.sites.poison': 'Scartati',
  'ops.sites.manual':
    'I segmenti da controllare e gli eventi scartati richiedono un operatore: vedi il runbook (pipeline del tracking).',
  'ops.backups.title': 'Backup',
  'ops.backups.none': 'Nessun backup.',
  'ops.backups.last': 'Ultimo il {at} ({n} conservati)',
  'ops.telemetry.title': "Statistiche d'uso anonime",
  'ops.telemetry.intro':
    "Una volta al giorno l'installazione invia conteggi anonimi (workspace, funnel, moduli, app, contatti solo a fasce) per decidere dove portare il progetto. Niente nomi, email, domini o dati dei contatti, con un id casuale che cambia quando la disattivi.",
  'ops.telemetry.docs': 'Cosa viene inviato',
  'ops.telemetry.on': 'Attive',
  'ops.telemetry.off': 'Disattivate',
  'ops.telemetry.portal': 'Si gestisce dal portale AmableData, nella pagina di questa installazione.',
  'ops.telemetry.envOff': 'Disattivate dalla configurazione del deploy (TELEMETRY=off).',
  'ops.telemetry.ownersOnly': 'Solo i proprietari del workspace possono cambiarla.',
  'ops.telemetry.neverSent': 'Ancora nessun invio.',
  'ops.telemetry.lastSent': 'Ultimo invio il {at}.',
  'ops.telemetry.showPreview': 'Mostra i dati esatti',
  'ops.telemetry.hidePreview': 'Nascondi i dati',
  'ops.telemetry.enabledToast': 'Statistiche anonime attivate',
  'ops.telemetry.disabledToast': 'Statistiche anonime disattivate: non viene più inviato nulla',
};
