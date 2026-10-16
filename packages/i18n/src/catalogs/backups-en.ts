/** English strings of Settings > Backups (spread into the main catalog). */
export const backupsEn = {
  'nav.backups': 'Backups',
  'backups.title': 'Backups',
  'backups.subtitle':
    'A full copy of this workspace (contacts, sales, email, automations, members and audit log) is saved every day. Only owners can create, download or restore backups.',
  'backups.create': 'Create backup',
  'backups.creating': 'Creating backup…',
  'backups.created': 'Backup created',
  'backups.download': 'Download',
  'backups.restore': 'Restore',
  'backups.list': 'Available backups',
  'backups.empty': 'No backups yet. The first daily backup runs within a day, or create one now.',
  'backups.col.date': 'Date',
  'backups.col.kind': 'Type',
  'backups.col.size': 'Size',
  'backups.kind.scheduled': 'Daily',
  'backups.kind.manual': 'Manual',
  'backups.retention': 'The last {scheduled} daily and {manual} manual backups are kept.',
  'backups.ownerOnly': 'Only the workspace owner can manage backups.',
  'backups.stepUp': 'Confirm it is you to continue',
  'backups.restore.title': 'Restore this backup?',
  'backups.restore.body':
    'Every contact, deal, order, email and automation of the workspace is replaced with the content of the backup taken on {date}. A safety backup of the current data is created first. Members, API keys and the audit log are not changed.',
  'backups.restore.confirmLabel': 'Type the workspace address "{slug}" to confirm',
  'backups.restore.submit': 'Replace data with this backup',
  'backups.restore.done': 'Backup restored. A safety copy of the previous data was saved.',
  'backups.help.title': 'How restore works',
  'backups.help.body':
    'Files are gzip-compressed JSON lines: one header line, then one line per row ({"db", "table", "row"}). Restore checks the whole file first (same workspace, same data version, nothing truncated), saves a safety backup, then replaces the workspace data. Backups made before an update must be restored on the same version they were created with. Avoid using the workspace while a restore is running.',
  'backups.error.backup_rate_limited': 'A backup was just created. Try again in a minute.',
  'backups.error.backup_schema_mismatch':
    'This backup was made with a different data version and cannot be restored automatically.',
  'backups.error.backup_invalid': 'The backup file is damaged or incomplete.',
  'backups.error.backup_wrong_tenant': 'This backup belongs to another workspace.',
  'backups.error.backup_not_found': 'Backup not found.',
  'backups.error.confirmation_mismatch': 'The confirmation does not match the workspace address.',
  'backups.error.generic': 'The operation failed. Please try again.',
} as const;

export type BackupsMessageKey = keyof typeof backupsEn;
