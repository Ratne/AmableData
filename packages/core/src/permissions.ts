/**
 * Central permission strings and the fixed role -> permissions matrix.
 *
 * Both the API middleware and the UI consume this single source of truth;
 * enforcement always happens on the server. API key scopes are chosen among
 * these same permissions and can never exceed the creator's role.
 */

export const PERMISSIONS = [
  // CRM
  'contacts:read',
  'contacts:write',
  'contacts:import',
  'contacts:export',
  'contacts:merge',
  /** Unmasked values of sensitive custom fields (e.g. SOCIAL_SECURITY_NUMBER). */
  'contacts:read_sensitive',
  'tags:write',
  'saved_searches:write',
  // Sales
  'opportunities:read',
  'opportunities:write',
  'tasks:read',
  'tasks:write',
  // Marketing
  'templates:write',
  'broadcasts:read',
  'broadcasts:write',
  'broadcasts:send',
  'automations:read',
  'automations:write',
  'automations:publish',
  /** Fire API goals (`POST /automationGoals/{callName}/trigger`), e.g. from integrations. */
  'automations:trigger',
  'forms:read',
  'forms:write',
  /** Decrypted submission values (personal data). */
  'forms:submissions_read',
  /** External connections of a form (webhooks, Google Sheets, email, e-signature). */
  'forms:connections_manage',
  // Landing pages
  'pages:read',
  'pages:write',
  'pages:publish',
  // Calendars & bookings
  'booking:read',
  /** Calendars, event types and availability. */
  'booking:write',
  /** Cancel / reschedule bookings made by contacts. */
  'booking:manage_bookings',
  // Electronic signatures
  'esign:read',
  /** Templates (PDF, parties, fields) and signature requests: send, remind, void. */
  'esign:write',
  'emails:send_single',
  /** Shared inbox: read conversations and messages of every channel. */
  'conversations:read',
  /** Reply, assign and close conversations. */
  'conversations:write',
  /** Add / remove addresses on the tenant suppression list. */
  'suppressions:write',
  // E-commerce
  'orders:read',
  'orders:write',
  /** Refunds move money back: owner/admin only. */
  'orders:refund',
  'products:read',
  'products:write',
  'subscriptions:read',
  'subscriptions:write',
  // Analytics
  'analytics:read',
  'analytics:configure',
  'analytics:journey_read',
  // Reports
  'reports:read',
  'reports:sales_read',
  'reports:create',
  'reports:export',
  // Administration
  'settings:manage',
  'users:manage',
  'domains:manage',
  'api_keys:manage',
  'webhooks:manage',
  'integrations:manage',
  /** Install marketplace apps (consent to their scopes). */
  'apps:install',
  /** Settings, scope re-approval, health and uninstall of installed apps. */
  'apps:manage',
  'audit:read',
  'data:bulk_delete',
  'data:export_full',
  // Owner-only
  'tenant:billing',
  'tenant:transfer',
  'tenant:delete',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Fixed roles — there are no custom roles. UI labels live in @amable/i18n. */
export const ROLES = ['owner', 'admin', 'marketer', 'sales', 'analyst', 'viewer'] as const;

export type Role = (typeof ROLES)[number];

const ALL_PERMISSIONS: readonly Permission[] = PERMISSIONS;

/** Read access to every module (used by analyst and viewer). */
const READ_ALL: readonly Permission[] = [
  'contacts:read',
  'opportunities:read',
  'tasks:read',
  'broadcasts:read',
  'automations:read',
  'forms:read',
  'forms:submissions_read',
  'pages:read',
  'booking:read',
  'esign:read',
  'conversations:read',
  'orders:read',
  'products:read',
  'subscriptions:read',
  'analytics:read',
  'analytics:journey_read',
  'reports:read',
  'reports:sales_read',
];

/**
 * Fixed role -> permissions matrix (plan section "Multiutente, tenant e ruoli"):
 * - owner: everything, the only role that manages billing, transfers ownership
 *   and deletes the tenant;
 * - admin: everything except billing/transfer/delete;
 * - marketer: full CRM + full marketing + analytics incl. configuration,
 *   reports read + contact export, read-only sales/e-commerce. No settings,
 *   users, domains or API keys;
 * - sales: CRM read/write, opportunities/tasks, manual orders, payments and
 *   subscriptions,
 *   single emails, read-only broadcasts/automations, contact journey only,
 *   sales reports, no bulk export;
 * - analyst: read everything, create/save reports and dashboards, CSV export,
 *   never modifies data;
 * - viewer: read-only everywhere, no export, no report creation; sensitive
 *   custom fields are masked at the data layer.
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  owner: ALL_PERMISSIONS,
  admin: ALL_PERMISSIONS.filter(
    (p) => p !== 'tenant:billing' && p !== 'tenant:transfer' && p !== 'tenant:delete',
  ),
  marketer: [
    'contacts:read',
    'contacts:write',
    'contacts:import',
    'contacts:export',
    'contacts:merge',
    'contacts:read_sensitive',
    'tags:write',
    'saved_searches:write',
    'templates:write',
    'broadcasts:read',
    'broadcasts:write',
    'broadcasts:send',
    'automations:read',
    'automations:write',
    'automations:publish',
    'automations:trigger',
    'forms:read',
    'forms:write',
    'forms:submissions_read',
    'forms:connections_manage',
    'pages:read',
    'pages:write',
    'pages:publish',
    'booking:read',
    'booking:write',
    'booking:manage_bookings',
    'esign:read',
    'esign:write',
    'emails:send_single',
    'conversations:read',
    'conversations:write',
    'suppressions:write',
    'analytics:read',
    'analytics:configure',
    'analytics:journey_read',
    'reports:read',
    'reports:sales_read',
    'opportunities:read',
    'tasks:read',
    'orders:read',
    'products:read',
    'subscriptions:read',
  ],
  sales: [
    'contacts:read',
    'contacts:write',
    'contacts:merge',
    'contacts:read_sensitive',
    'tags:write',
    'saved_searches:write',
    'opportunities:read',
    'opportunities:write',
    'tasks:read',
    'tasks:write',
    'booking:read',
    'booking:write',
    'booking:manage_bookings',
    'esign:read',
    'esign:write',
    'orders:read',
    'orders:write',
    'products:read',
    'subscriptions:read',
    'subscriptions:write',
    'emails:send_single',
    'conversations:read',
    'conversations:write',
    'broadcasts:read',
    'automations:read',
    'automations:trigger',
    'analytics:journey_read',
    'reports:sales_read',
  ],
  analyst: [
    ...READ_ALL,
    'reports:create',
    'reports:export',
    'contacts:read_sensitive',
    'saved_searches:write',
  ],
  viewer: READ_ALL,
};

/** True when `role` grants `permission`. */
export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
