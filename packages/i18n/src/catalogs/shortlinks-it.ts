import type { ShortlinksMessageKey } from './shortlinks-en';

/** Italian strings of short links — must cover every key of shortlinks-en. */
export const shortlinksIt: Readonly<Record<ShortlinksMessageKey, string>> = {
  'nav.shortlinks': 'Short link',
  'shortlinks.new': 'Nuovo link',
  'shortlinks.edit': 'Modifica link',
  'shortlinks.saved': 'Salvato',
  'shortlinks.search': 'Cerca key, URL, titolo, dominio',
  'shortlinks.showArchived': 'Mostra archiviati',
  'shortlinks.empty': 'Ancora nessuno short link.',
  'shortlinks.emptyFiltered': 'Nessun link corrisponde ai filtri.',
  'shortlinks.copy': 'Copia link',
  'shortlinks.copied': 'Link copiato',
  'shortlinks.dialog.description':
    'Le visite allo short URL vengono reindirizzate alla destinazione con i parametri UTM qui sotto.',

  'shortlinks.col.link': 'Short link',
  'shortlinks.col.destination': 'Destinazione',
  'shortlinks.col.status': 'Stato',
  'shortlinks.col.created': 'Creato',
  'shortlinks.col.clicks': 'Click',

  'shortlinks.status.active': 'Attivo',
  'shortlinks.status.archived': 'Archiviato',
  'shortlinks.status.expired': 'Scaduto',
  'shortlinks.status.noDomain': 'Dominio rimosso',

  'shortlinks.folder.all': 'Tutte le cartelle',
  'shortlinks.folder.none': 'Senza cartella',

  'shortlinks.field.folder': 'Cartella',
  'shortlinks.field.domain': 'Dominio',
  'shortlinks.field.domainPlaceholder': 'Scegli un dominio',
  'shortlinks.field.domainFolderHint': 'Limitato ai domini della cartella.',
  'shortlinks.field.key': 'Key',
  'shortlinks.field.keyPlaceholder': 'Vuoto = generata',
  'shortlinks.field.keyInvalid': 'Solo lettere, cifre, - e _ (max 64).',
  'shortlinks.field.title': 'Titolo (interno)',
  'shortlinks.field.url': 'URL di destinazione',
  'shortlinks.field.passQuery': 'Inoltra i parametri query della visita',
  'shortlinks.field.passQueryHint':
    'Vengono aggiunti alla destinazione e sovrascrivono le UTM qui sopra.',
  'shortlinks.field.expiresAt': 'Scade il',
  'shortlinks.field.expiredUrl': 'URL dopo la scadenza',
  'shortlinks.field.expiredUrlHint': 'Vuoto: le visite dopo la scadenza ricevono un 404.',
  'shortlinks.field.ogTitle': 'Titolo',
  'shortlinks.field.ogDescription': 'Descrizione',
  'shortlinks.field.ogImage': 'URL immagine',
  'shortlinks.field.archived': 'Archiviato (il link smette di reindirizzare)',

  'shortlinks.utm.title': 'Parametri UTM',
  'shortlinks.utm.preview': 'Destinazione',
  'shortlinks.expiry.title': 'Scadenza',
  'shortlinks.og.title': 'Anteprima social',
  'shortlinks.og.hint':
    'Mostrata da social e app di messaggistica quando il link viene condiviso. Vuota: leggono la pagina di destinazione.',

  'shortlinks.noDomain.title': 'Collega un dominio per gli short link',
  'shortlinks.noDomain.body':
    'I link vivono su un hostname dedicato come go.example.com, collegato e verificato con tipo “Short link”.',
  'shortlinks.noDomain.link': 'Impostazioni > Domini',

  'shortlinks.qr.title': 'QR code',
  'shortlinks.qr.alt': 'QR code di {url}',
  'shortlinks.qr.noDomain': 'Il dominio di questo link è stato rimosso.',

  'shortlinks.stats.title': 'Statistiche',
  'shortlinks.stats.period': 'Periodo',
  'shortlinks.stats.lastDays': 'Ultimi {days} giorni',
  'shortlinks.stats.total': 'Click totali',
  'shortlinks.stats.humansPeriod': 'Persone nel periodo',
  'shortlinks.stats.botsPeriod': 'Bot nel periodo',
  'shortlinks.stats.humans': 'Persone',
  'shortlinks.stats.bots': 'Bot',
  'shortlinks.stats.countries': 'Paesi',
  'shortlinks.stats.referrers': 'Provenienza',
  'shortlinks.stats.devices': 'Dispositivi',
  'shortlinks.stats.browsers': 'Browser',
  'shortlinks.stats.unknown': 'Sconosciuto',
  'shortlinks.stats.direct': 'Diretto / nessuno',
  'shortlinks.stats.noData': 'Nessun click nel periodo.',
  'shortlinks.stats.humanOnly':
    'I dettagli contano solo le persone; i giorni sono in UTC. I click totali includono i bot e tutti i giorni dalla creazione.',

  'shortlinks.folders.title': 'Cartelle',
  'shortlinks.folders.description':
    'Le cartelle raggruppano i link. Una cartella associata a dei domini limita (e preseleziona) i domini dei suoi link.',
  'shortlinks.folders.name': 'Nome cartella',
  'shortlinks.folders.newPlaceholder': 'Nuova cartella',
  'shortlinks.folders.create': 'Crea',
  'shortlinks.folders.created': 'Cartella creata',
  'shortlinks.folders.delete': 'Elimina cartella',
  'shortlinks.folders.deleted': 'Cartella eliminata',
  'shortlinks.folders.confirmDelete':
    'Eliminare la cartella “{name}”? I suoi link restano, senza cartella.',
  'shortlinks.folders.linkCount': '{count} link',
  'shortlinks.folders.empty': 'Ancora nessuna cartella.',
  'shortlinks.folders.noDomains': 'Nessun dominio short link collegato.',

  'shortlinks.error.forbidden': 'Non hai accesso agli short link.',
  'shortlinks.error.notFound': 'Questo link non esiste più.',
  'shortlinks.error.conflict': 'Questa key è già usata sul dominio.',
  'shortlinks.error.validation': 'Alcuni valori non sono validi.',
};
