/** English strings of the operations page (spread into the main catalog). */
export const opsEn = {
  'nav.operations': 'Operations',
  'ops.title': 'Operations',
  'ops.intro':
    'What is stuck or behind in this workspace, and how to recover it. Refreshed every minute.',
  'ops.never': 'never',
  'ops.forbidden': 'Only admins of the workspace see the operations page.',
  'ops.registry.title': 'Contact registry',
  'ops.registry.empty': 'No parked messages',
  'ops.registry.parked': '{n} messages parked after their retries',
  'ops.registry.parkedMore': 'More than {n} messages parked after their retries',
  'ops.registry.hint':
    'Leads and identities that could not reach the contacts (oldest: {at}). Replay them once the cause is fixed: a replay never creates duplicates.',
  'ops.registry.replay': 'Replay',
  'ops.registry.replayed': '{n} messages replayed',
  'ops.registry.replayedMore': '{n} messages replayed, more are left: replay again',
  'ops.registry.failedAgain': '{n} failed again and stay parked (see the error logs)',
  'ops.sites.title': 'Tracking',
  'ops.sites.empty': 'No sites yet.',
  'ops.sites.site': 'Site',
  'ops.sites.lastEvent': 'Last event',
  'ops.sites.pending': 'Waiting for replay',
  'ops.sites.stale': 'To check',
  'ops.sites.poison': 'Rejected',
  'ops.sites.manual':
    'Segments to check and rejected events need an operator: see the runbook (tracking pipeline).',
  'ops.backups.title': 'Backups',
  'ops.backups.none': 'No backup yet.',
  'ops.backups.last': 'Last on {at} ({n} kept)',
} as const;

export type OpsMessageKey = keyof typeof opsEn;
