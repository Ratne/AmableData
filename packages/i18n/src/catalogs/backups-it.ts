import type { BackupsMessageKey } from './backups-en';

/** Italian strings of Impostazioni > Backup — must cover every key of backups-en. */
export const backupsIt: Readonly<Record<BackupsMessageKey, string>> = {
  'nav.backups': 'Backup',
  'backups.title': 'Backup',
  'backups.subtitle':
    "Ogni giorno viene salvata una copia completa di questo spazio di lavoro (contatti, vendite, email, automazioni, membri e registro attività). Solo i proprietari possono creare, scaricare o ripristinare i backup.",
  'backups.create': 'Crea backup',
  'backups.creating': 'Creazione del backup…',
  'backups.created': 'Backup creato',
  'backups.download': 'Scarica',
  'backups.restore': 'Ripristina',
  'backups.list': 'Backup disponibili',
  'backups.empty': 'Nessun backup per ora. Il primo backup giornaliero parte entro un giorno, oppure creane uno adesso.',
  'backups.col.date': 'Data',
  'backups.col.kind': 'Tipo',
  'backups.col.size': 'Dimensione',
  'backups.kind.scheduled': 'Giornaliero',
  'backups.kind.manual': 'Manuale',
  'backups.retention': 'Vengono conservati gli ultimi {scheduled} backup giornalieri e {manual} manuali.',
  'backups.ownerOnly': 'Solo il proprietario dello spazio di lavoro può gestire i backup.',
  'backups.stepUp': 'Conferma la tua identità per continuare',
  'backups.restore.title': 'Ripristinare questo backup?',
  'backups.restore.body':
    "Contatti, opportunità, ordini, email e automazioni dello spazio di lavoro vengono sostituiti con il contenuto del backup del {date}. Prima viene creato un backup di sicurezza dei dati attuali. Membri, chiavi API e registro attività non cambiano.",
  'backups.restore.confirmLabel': 'Scrivi l\'indirizzo dello spazio di lavoro "{slug}" per confermare',
  'backups.restore.submit': 'Sostituisci i dati con questo backup',
  'backups.restore.done': 'Backup ripristinato. È stata salvata una copia di sicurezza dei dati precedenti.',
  'backups.help.title': 'Come funziona il ripristino',
  'backups.help.body':
    "I file sono righe JSON compresse con gzip: una riga di intestazione, poi una riga per ogni record ({\"db\", \"table\", \"row\"}). Il ripristino controlla prima l'intero file (stesso spazio di lavoro, stessa versione dei dati, nessuna parte mancante), salva un backup di sicurezza e poi sostituisce i dati. Un backup fatto prima di un aggiornamento va ripristinato sulla stessa versione in cui è stato creato. Evita di usare lo spazio di lavoro durante il ripristino.",
  'backups.error.backup_rate_limited': 'È appena stato creato un backup. Riprova tra un minuto.',
  'backups.error.backup_schema_mismatch':
    'Questo backup è stato creato con una versione dei dati diversa e non può essere ripristinato automaticamente.',
  'backups.error.backup_invalid': 'Il file di backup è danneggiato o incompleto.',
  'backups.error.backup_wrong_tenant': 'Questo backup appartiene a un altro spazio di lavoro.',
  'backups.error.backup_not_found': 'Backup non trovato.',
  'backups.error.confirmation_mismatch': "La conferma non corrisponde all'indirizzo dello spazio di lavoro.",
  'backups.error.generic': "L'operazione non è riuscita. Riprova.",
};
