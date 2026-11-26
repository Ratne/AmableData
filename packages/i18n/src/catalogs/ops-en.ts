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
  'ops.telemetry.title': 'Anonymous usage statistics',
  'ops.telemetry.intro':
    'Once a day the installation sends anonymous counts (workspaces, funnels, forms, apps, contacts as a range) to help decide where the project goes. No names, emails, domains or contact data, under a random id that is replaced when you switch it off.',
  'ops.telemetry.docs': 'What is sent',
  'ops.telemetry.on': 'On',
  'ops.telemetry.off': 'Off',
  'ops.telemetry.portal': 'Managed in the AmableData portal, on the page of this installation.',
  'ops.telemetry.envOff': 'Switched off by the deployment (TELEMETRY=off).',
  'ops.telemetry.ownersOnly': 'Only the workspace owners can change it.',
  'ops.telemetry.neverSent': 'Nothing sent yet.',
  'ops.telemetry.lastSent': 'Last sent on {at}.',
  'ops.telemetry.showPreview': 'Show the exact data',
  'ops.telemetry.hidePreview': 'Hide the data',
  'ops.telemetry.enabledToast': 'Anonymous statistics on',
  'ops.telemetry.disabledToast': 'Anonymous statistics off: nothing more is sent',
} as const;

export type OpsMessageKey = keyof typeof opsEn;
