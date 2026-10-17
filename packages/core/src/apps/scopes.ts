import { PERMISSIONS, type Permission } from '../permissions';

/**
 * Scopes an app may request: every tenant permission except the ones that
 * administer people, keys, apps or the workspace itself. An app is bounded by
 * its granted scopes for as long as it stays installed.
 */
export const APP_FORBIDDEN_SCOPES: readonly Permission[] = [
  'users:manage',
  'api_keys:manage',
  'apps:install',
  'apps:manage',
  'tenant:billing',
  'tenant:transfer',
  'tenant:delete',
];

export const APP_SCOPES: readonly Permission[] = PERMISSIONS.filter(
  (p) => !APP_FORBIDDEN_SCOPES.includes(p),
);

/** Scopes shown with an explicit warning at consent; only the owner may grant them. */
export const APP_SENSITIVE_SCOPES: readonly Permission[] = [
  'contacts:read_sensitive',
  'data:export_full',
  'data:bulk_delete',
  'orders:refund',
];

/** Scopes that hand personal data of contacts to the app (GDPR webhooks become mandatory). */
export const APP_PERSONAL_DATA_SCOPES: readonly Permission[] = [
  'contacts:read',
  'contacts:read_sensitive',
  'contacts:export',
  'forms:submissions_read',
  'orders:read',
  'booking:read',
  'conversations:read',
  'analytics:journey_read',
  'data:export_full',
];

/**
 * Events every app receives regardless of its subscriptions (lifecycle and
 * privacy). Privacy events are only sent to apps that handle personal data.
 */
export const APP_LIFECYCLE_EVENTS = [
  'app.installed',
  'app.uninstalled',
  'app.scopes_pending',
  'app.scopes_granted',
  'app.secret_rotated',
] as const;

export const APP_PRIVACY_EVENTS = ['privacy.erasure_requested', 'privacy.data_requested'] as const;

/** Domain event prefix → permission needed to receive it (the payload is readable data). */
const EVENT_PERMISSIONS: ReadonlyArray<readonly [prefix: string, permission: Permission]> = [
  ['contact.', 'contacts:read'],
  ['company.', 'contacts:read'],
  ['note.', 'contacts:read'],
  ['import.', 'contacts:read'],
  ['task.', 'tasks:read'],
  ['appointment.', 'tasks:read'],
  ['opportunity.', 'opportunities:read'],
  ['order.', 'orders:read'],
  ['payment.', 'orders:read'],
  ['invoice.', 'orders:read'],
  ['refund.', 'orders:read'],
  ['subscription.', 'subscriptions:read'],
  ['product.', 'products:read'],
  ['form.', 'forms:read'],
  ['booking.', 'booking:read'],
  ['page.', 'pages:read'],
  ['email.', 'broadcasts:read'],
  ['broadcast.', 'broadcasts:read'],
  ['automation.', 'automations:read'],
  ['analytics.', 'analytics:read'],
  ['conversation.', 'conversations:read'],
  ['message.', 'conversations:read'],
];

/** Permission an app needs to subscribe to `eventType`; null when apps cannot subscribe to it. */
export function eventReadPermission(eventType: string): Permission | null {
  for (const [prefix, permission] of EVENT_PERMISSIONS) {
    if (eventType.startsWith(prefix)) return permission;
  }
  return null;
}

/** Subscribed events the scopes do not cover (empty = consistent manifest). */
export function eventsBeyondScopes(events: readonly string[], scopes: readonly string[]): string[] {
  const granted = new Set(scopes);
  return events.filter((event) => {
    const permission = eventReadPermission(event);
    return permission === null || !granted.has(permission);
  });
}

export function handlesPersonalData(scopes: readonly string[]): boolean {
  return scopes.some((s) => (APP_PERSONAL_DATA_SCOPES as readonly string[]).includes(s));
}
