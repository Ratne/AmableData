import { z } from 'zod';
import { APP_SCOPES, eventsBeyondScopes, handlesPersonalData } from './scopes';

/**
 * App manifest — the public contract between a third-party app and every
 * AmableData installation. Published in the catalog repo (`apps/<id>/manifest.json`)
 * or served from the app's own URL for private apps.
 *
 * Every endpoint the CRM calls is a path relative to `base_url`: an app can
 * never point a hook at another host.
 */

/** API versions this release serves; the newest is the default for new apps. */
export const APP_API_VERSIONS = ['2026-10'] as const;
export type AppApiVersion = (typeof APP_API_VERSIONS)[number];
export const CURRENT_APP_API_VERSION: AppApiVersion = '2026-10';
/** Months a deprecated API version keeps being served after its successor ships. */
export const APP_API_DEPRECATION_MONTHS = 12;

export const APP_MANIFEST_SCHEMA_VERSION = 1;

export const APP_CATEGORIES = [
  'data_quality',
  'messaging',
  'marketing',
  'sales',
  'commerce',
  'analytics',
  'productivity',
  'forms',
  'support',
  'developer',
] as const;

export const APP_UI_SLOTS = [
  'contact.sidebar',
  'contact.actions',
  'app.page',
  'app.settings',
  'dashboard.widget',
] as const;
export type AppUiSlot = (typeof APP_UI_SLOTS)[number];

/** Sidebar groups an `app.page` can join; without one it is listed under "Apps". */
export const APP_NAV_GROUPS = ['crm', 'marketing', 'ecommerce', 'analytics', 'reports'] as const;
export type AppNavGroup = (typeof APP_NAV_GROUPS)[number];

/** Extension points an installation advertises in `/.well-known/amable-apps.json`. */
export const APP_EXTENSION_POINTS = [
  'contact.validate',
  'contact.address_lookup',
  'contact.timeline',
  'automation.actions',
  'automation.triggers',
  'form.connectors',
  'conversations.channels',
  'conversations.templates',
  'conversations.outbound',
  'automation.dynamic_options',
  'app.data',
  'app.entity_data',
  'events.replay',
  ...APP_UI_SLOTS.map((slot) => `ui.${slot}` as const),
] as const;

export const APP_VALIDATE_FIELDS = ['email', 'phone'] as const;
/** Custom field types an app may declare (a subset of the CRM's types, without options). */
export const APP_CUSTOM_FIELD_TYPES = [
  'TEXT',
  'TEXT_AREA',
  'WHOLE_NUMBER',
  'DECIMAL_NUMBER',
  'YES_NO',
  'DATE',
  'DATE_TIME',
  'WEBSITE',
  'EMAIL',
  'PHONE_NUMBER',
] as const;
export const APP_ENTITY_KINDS = ['contact', 'company', 'opportunity', 'order'] as const;
export type AppEntityKind = (typeof APP_ENTITY_KINDS)[number];
export const APP_CHANNEL_KINDS = ['whatsapp', 'sms', 'telegram', 'messenger', 'other'] as const;

const APP_ID_RE = /^[a-z][a-z0-9-]{2,39}$/;
const KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;

const httpsUrl = z
  .string()
  .max(2000)
  .url()
  .refine((value) => value.startsWith('https://'), 'must be an https URL');

/** Same as httpsUrl, plus http://localhost / 127.0.0.1 for private apps in development. */
const devUrl = z
  .string()
  .max(2000)
  .url()
  .refine(
    (value) => value.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(value),
    'must be an https URL',
  );

const relativePath = z
  .string()
  .max(300)
  .regex(/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/, 'must be a path starting with /')
  .refine((value) => !value.startsWith('//') && !value.includes('..'), 'must stay on base_url');

export const localizedTextSchema = z
  .strictObject({ en: z.string().min(1).max(500), it: z.string().min(1).max(500).optional() })
  .describe('Text per locale; `en` is required');
export type LocalizedText = z.infer<typeof localizedTextSchema>;

const shortText = z.strictObject({ en: z.string().min(1).max(80), it: z.string().min(1).max(80).optional() });

const scopeSchema = z.enum(APP_SCOPES as unknown as [string, ...string[]]);

/** JSON Schema subset for action inputs and connector settings: flat objects of primitives. */
export const appInputPropertySchema = z.strictObject({
  type: z.enum(['string', 'number', 'integer', 'boolean']),
  title: shortText,
  description: localizedTextSchema.optional(),
  enum: z.array(z.string().max(100)).min(1).max(50).optional(),
  format: z.enum(['text', 'textarea', 'email', 'url', 'phone']).optional(),
  default: z.union([z.string().max(2000), z.number(), z.boolean()]).optional(),
  max_length: z.number().int().min(1).max(10_000).optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  /** Strings may contain merge tags such as `{{contact.first_name}}`, resolved at run time. */
  merge_tags: z.boolean().optional(),
  /**
   * Choices that depend on the workspace (its templates, lists, pipelines):
   * the editor asks the app, with a signed POST to this path, for
   * `{ options: [{ value, label, description? }] }`.
   */
  options_endpoint: relativePath.optional(),
});
export type AppInputProperty = z.infer<typeof appInputPropertySchema>;

export const appInputSchemaSchema = z
  .strictObject({
    type: z.literal('object'),
    properties: z.record(z.string().regex(KEY_RE), appInputPropertySchema),
    required: z.array(z.string().regex(KEY_RE)).max(50).optional(),
  })
  .refine(
    (schema) => Object.keys(schema.properties).length <= 30,
    'at most 30 properties',
  )
  .refine(
    (schema) => (schema.required ?? []).every((key) => Object.hasOwn(schema.properties, key)),
    'required lists an unknown property',
  );
export type AppInputSchema = z.infer<typeof appInputSchemaSchema>;

const contactValidateSchema = z.strictObject({
  fields: z.array(z.enum(APP_VALIDATE_FIELDS)).min(1).max(APP_VALIDATE_FIELDS.length),
  endpoint: relativePath.default('/hooks/validate'),
  batch_endpoint: relativePath.optional(),
  /** Results are cached per value; 0 disables the cache. */
  cache_ttl_seconds: z.number().int().min(0).max(90 * 24 * 3600).default(7 * 24 * 3600),
});

/**
 * Address autocomplete of the contact editor: the CRM posts `{ q, lang, country }`
 * and shows the `suggestions` instead of the installation's geocoder
 * (OpenStreetMap), which stays the fallback when the app fails.
 */
const addressLookupSchema = z.strictObject({
  endpoint: relativePath,
  /** Shown under the suggestions, as the provider's terms require (`© Mapbox © OpenStreetMap`). */
  attribution: z.string().trim().min(1).max(120).optional(),
});

const automationActionSchema = z.strictObject({
  key: z.string().regex(KEY_RE),
  name: shortText,
  description: localizedTextSchema.optional(),
  endpoint: relativePath,
  input_schema: appInputSchemaSchema,
  /** Keys of the result the following steps may use (`{{steps.<step>.<key>}}`). */
  output_keys: z.array(z.string().regex(KEY_RE)).max(20).optional(),
});

const automationTriggerSchema = z.strictObject({
  key: z.string().regex(KEY_RE),
  name: shortText,
  description: localizedTextSchema.optional(),
});

const uiExtensionSchema = z.strictObject({
  slot: z.enum(APP_UI_SLOTS),
  key: z.string().regex(KEY_RE),
  path: relativePath,
  title: shortText,
  /** Initial iframe height in px (the app can resize through the bridge). */
  height: z.number().int().min(40).max(2000).optional(),
  /** `app.page` only: the sidebar group the page is listed in. */
  nav_group: z.enum(APP_NAV_GROUPS).optional(),
});

const formConnectorSchema = z.strictObject({
  key: z.string().regex(KEY_RE),
  name: shortText,
  description: localizedTextSchema.optional(),
  endpoint: relativePath,
  settings_schema: appInputSchemaSchema.optional(),
});

const channelSchema = z.strictObject({
  key: z.string().regex(KEY_RE),
  name: shortText,
  kind: z.enum(APP_CHANNEL_KINDS),
  send_endpoint: relativePath,
  /** Address the channel uses to reach a contact. */
  address_field: z.enum(['phone', 'email', 'external_id']).default('phone'),
  /**
   * Free-form replies are allowed only this long after the contact's last
   * message (WhatsApp: 24); after that the team must send a template.
   */
  reply_window_hours: z.number().int().min(1).max(720).optional(),
  /** Signed POST answering `{ templates: [...] }`: the approved templates the team can send. */
  templates_endpoint: relativePath.optional(),
});

/**
 * Origin of an app that runs in the workspace's own Cloudflare account: the
 * catalog manifest uses it in `base_url`, `jwks_url` and `redirect_uris`, and
 * every installation replaces it with the URL of the Worker it deployed
 * (`resolveDeployedManifest`). `.invalid` never resolves (RFC 2606).
 */
export const DEPLOYED_APP_ORIGIN = 'https://deployed-app.invalid';

/**
 * How the CRM deploys the app into the workspace's Cloudflare account: one
 * module Worker (`bundle_url`, checked against `bundle_sha256`), its D1
 * databases and cron triggers. Nothing runs in the catalog maintainer's account.
 * The app's source manifest declares the resources; the release adds the
 * bundle (`bundle_url`, `bundle_sha256`) to the catalog copy.
 */
export const appDeploymentSchema = z.strictObject({
  kind: z.literal('cloudflare_worker'),
  bundle_url: httpsUrl.optional(),
  bundle_sha256: z.string().regex(/^[0-9a-f]{64}$/, 'lowercase hex SHA-256').optional(),
  compatibility_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  compatibility_flags: z.array(z.string().regex(/^[a-z0-9_]{1,60}$/)).max(10).default([]),
  d1: z
    .array(z.strictObject({ binding: z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/) }))
    .max(3)
    .default([]),
  cron: z.array(z.string().min(9).max(60)).max(3).default([]),
});
export type AppDeployment = z.infer<typeof appDeploymentSchema>;

const customFieldSchema = z.strictObject({
  key: z.string().regex(KEY_RE),
  label: shortText,
  type: z.enum(APP_CUSTOM_FIELD_TYPES),
  entity: z.enum(['contact', 'company', 'opportunity']).default('contact'),
});

export const appManifestSchema = z
  .strictObject({
    schema_version: z.literal(APP_MANIFEST_SCHEMA_VERSION),
    id: z.string().regex(APP_ID_RE, 'lowercase letters, digits and dashes, 3-40 chars'),
    name: z.string().min(2).max(60),
    /** Release of the app (semver), bumped with every published change; shown to admins. */
    version: z
      .string()
      .regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/, 'semver: MAJOR.MINOR.PATCH')
      .optional(),
    tagline: shortText,
    description: localizedTextSchema,
    developer: z.strictObject({
      name: z.string().min(2).max(100),
      url: httpsUrl,
      email: z.string().email().max(200),
    }),
    categories: z.array(z.enum(APP_CATEGORIES)).min(1).max(3),
    icon_url: devUrl,
    homepage: httpsUrl,
    support_url: httpsUrl,
    privacy_url: httpsUrl,
    base_url: devUrl.refine((value) => !value.endsWith('/'), 'no trailing slash'),
    jwks_url: devUrl,
    redirect_uris: z.array(devUrl).min(1).max(10),
    /** Minimum AmableData release (`YYYY.M.N`). */
    min_version: z
      .string()
      .regex(/^\d{4}\.\d{1,2}\.\d{1,3}$/)
      .optional(),
    api_version: z.string().regex(/^\d{4}-\d{2}$/),
    scopes: z.array(scopeSchema).max(60),
    webhooks: z
      .strictObject({
        endpoint: relativePath.default('/webhooks'),
        events: z.array(z.string().min(3).max(80)).max(100).default([]),
      })
      .default({ endpoint: '/webhooks', events: [] }),
    privacy: z.strictObject({
      handles_personal_data: z.boolean(),
      erasure_endpoint: relativePath.optional(),
      data_request_endpoint: relativePath.optional(),
    }),
    custom_fields: z.array(customFieldSchema).max(20).default([]),
    pricing: z
      .strictObject({
        model: z.enum(['free', 'freemium', 'paid']),
        billing_url: httpsUrl.optional(),
        note: localizedTextSchema.optional(),
      })
      .default({ model: 'free' }),
    extensions: z
      .strictObject({
        contact_validate: contactValidateSchema.optional(),
        address_lookup: addressLookupSchema.optional(),
        automation_actions: z.array(automationActionSchema).max(30).optional(),
        automation_triggers: z.array(automationTriggerSchema).max(30).optional(),
        ui: z.array(uiExtensionSchema).max(20).optional(),
        form_connectors: z.array(formConnectorSchema).max(10).optional(),
        channels: z.array(channelSchema).max(5).optional(),
      })
      .default({}),
    deployment: appDeploymentSchema.optional(),
  })
  .superRefine((manifest, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    const scopes = new Set<string>(manifest.scopes);
    if (scopes.size !== manifest.scopes.length) issue(['scopes'], 'duplicate scopes');

    const beyond = eventsBeyondScopes(manifest.webhooks.events, manifest.scopes);
    if (beyond.length > 0) {
      issue(['webhooks', 'events'], `events not covered by the scopes: ${beyond.join(', ')}`);
    }

    const personal = handlesPersonalData(manifest.scopes);
    if (personal && !manifest.privacy.handles_personal_data) {
      issue(['privacy', 'handles_personal_data'], 'the scopes give access to personal data');
    }
    if (manifest.privacy.handles_personal_data) {
      if (manifest.privacy.erasure_endpoint === undefined) {
        issue(['privacy', 'erasure_endpoint'], 'required for apps that handle personal data');
      }
      if (manifest.privacy.data_request_endpoint === undefined) {
        issue(['privacy', 'data_request_endpoint'], 'required for apps that handle personal data');
      }
    }

    const ext = manifest.extensions;
    const needs = (condition: boolean, scope: string, path: (string | number)[]) => {
      if (condition && !scopes.has(scope)) issue(path, `requires the ${scope} scope`);
    };
    needs(ext.contact_validate !== undefined, 'contacts:read', ['extensions', 'contact_validate']);
    needs(ext.address_lookup !== undefined, 'contacts:read', ['extensions', 'address_lookup']);
    needs((ext.form_connectors ?? []).length > 0, 'forms:submissions_read', ['extensions', 'form_connectors']);
    needs((ext.channels ?? []).length > 0, 'conversations:write', ['extensions', 'channels']);
    needs(manifest.custom_fields.length > 0, 'contacts:write', ['custom_fields']);
    (ext.channels ?? []).forEach((channel, i) => {
      if (channel.reply_window_hours !== undefined && channel.templates_endpoint === undefined) {
        issue(['extensions', 'channels', i, 'templates_endpoint'], 'a channel with a reply window needs templates to reopen it');
      }
    });
    const inputs = (schema: AppInputSchema | undefined, path: (string | number)[]) => {
      for (const [key, property] of Object.entries(schema?.properties ?? {})) {
        if (property.options_endpoint !== undefined && (property.type !== 'string' || property.enum !== undefined)) {
          issue([...path, key], 'options_endpoint is for string properties without enum');
        }
      }
    };
    (ext.automation_actions ?? []).forEach((a, i) => inputs(a.input_schema, ['extensions', 'automation_actions', i, 'input_schema', 'properties']));
    (ext.form_connectors ?? []).forEach((f, i) => inputs(f.settings_schema, ['extensions', 'form_connectors', i, 'settings_schema', 'properties']));

    const unique = (keys: string[], path: (string | number)[]) => {
      if (new Set(keys).size !== keys.length) issue(path, 'duplicate keys');
    };
    unique((ext.automation_actions ?? []).map((a) => a.key), ['extensions', 'automation_actions']);
    unique((ext.automation_triggers ?? []).map((a) => a.key), ['extensions', 'automation_triggers']);
    unique((ext.ui ?? []).map((u) => u.key), ['extensions', 'ui']);
    unique((ext.form_connectors ?? []).map((u) => u.key), ['extensions', 'form_connectors']);
    unique((ext.channels ?? []).map((u) => u.key), ['extensions', 'channels']);
    unique(manifest.custom_fields.map((f) => f.key), ['custom_fields']);
    if ((ext.ui ?? []).filter((u) => u.slot === 'app.settings').length > 1) {
      issue(['extensions', 'ui'], 'at most one app.settings screen');
    }
    (ext.ui ?? []).forEach((u, i) => {
      if (u.nav_group !== undefined && u.slot !== 'app.page') issue(['extensions', 'ui', i, 'nav_group'], 'only for app.page');
    });

    const onDeployed = (value: string) => value === DEPLOYED_APP_ORIGIN || value.startsWith(`${DEPLOYED_APP_ORIGIN}/`);
    const deployedTemplate = manifest.base_url === DEPLOYED_APP_ORIGIN;
    if (deployedTemplate && manifest.deployment === undefined) {
      issue(['base_url'], `${DEPLOYED_APP_ORIGIN} is only for apps with a deployment`);
    }
    if (onDeployed(manifest.icon_url)) issue(['icon_url'], 'the icon is shown before the app is deployed: host it elsewhere');
    for (const [path, value] of [
      [['jwks_url'], manifest.jwks_url],
      ...manifest.redirect_uris.map((uri, i) => [['redirect_uris', i], uri] as const),
    ] as Array<readonly [(string | number)[], string]>) {
      if (onDeployed(value) !== deployedTemplate) {
        issue(path, deployedTemplate ? `must be under ${DEPLOYED_APP_ORIGIN}` : `${DEPLOYED_APP_ORIGIN} is only for deployed apps`);
      }
    }

    // Development URLs (http://localhost) are fine for private apps only.
    const base = new URL(manifest.base_url);
    for (const [path, value] of [
      [['jwks_url'], manifest.jwks_url],
      ...manifest.redirect_uris.map((uri, i) => [['redirect_uris', i], uri] as const),
    ] as Array<readonly [(string | number)[], string]>) {
      if (new URL(value).protocol !== base.protocol) issue(path, 'must use the same scheme as base_url');
    }
  });

export type AppManifest = z.infer<typeof appManifestSchema>;
export type AppManifestInput = z.input<typeof appManifestSchema>;
export type AppAutomationAction = NonNullable<AppManifest['extensions']['automation_actions']>[number];
export type AppAutomationTrigger = NonNullable<AppManifest['extensions']['automation_triggers']>[number];
export type AppUiExtension = NonNullable<AppManifest['extensions']['ui']>[number];
export type AppFormConnector = NonNullable<AppManifest['extensions']['form_connectors']>[number];
export type AppChannel = NonNullable<AppManifest['extensions']['channels']>[number];
export type AppCustomField = AppManifest['custom_fields'][number];

export type ManifestCheck =
  | { ok: true; manifest: AppManifest }
  | { ok: false; issues: Array<{ path: string; message: string }> };

export function parseAppManifest(input: unknown): ManifestCheck {
  const result = appManifestSchema.safeParse(input);
  if (result.success) return { ok: true, manifest: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.') || '(root)',
      message: issue.message,
    })),
  };
}

/** True when the manifest uses development URLs (allowed only for private apps). */
export function isDevelopmentManifest(manifest: AppManifest): boolean {
  return !manifest.base_url.startsWith('https://');
}

export type ReleasedDeployment = AppDeployment & { bundle_url: string; bundle_sha256: string };

/** Catalog manifest of an app the CRM deploys into the workspace's Cloudflare account. */
export function isDeployableManifest(manifest: AppManifest): manifest is AppManifest & { deployment: ReleasedDeployment } {
  return (
    manifest.deployment?.bundle_url !== undefined &&
    manifest.deployment.bundle_sha256 !== undefined &&
    manifest.base_url === DEPLOYED_APP_ORIGIN
  );
}

/**
 * The manifest of one deployed copy: every `DEPLOYED_APP_ORIGIN` URL moved to
 * the Worker's origin. Everything else (scopes, endpoints, privacy) is the
 * catalog's, so a deployed app can never claim more than was reviewed.
 */
export function resolveDeployedManifest(manifest: AppManifest, origin: string): AppManifest {
  if (!isDeployableManifest(manifest)) throw new Error(`${manifest.id} is not a deployable app`);
  const target = new URL(origin).origin;
  const move = (value: string) => `${target}${value.slice(DEPLOYED_APP_ORIGIN.length)}`;
  return {
    ...manifest,
    base_url: target,
    jwks_url: move(manifest.jwks_url),
    redirect_uris: manifest.redirect_uris.map(move),
  };
}

/** Worker script of a deployed app in the workspace's account. */
export function appWorkerName(appId: string): string {
  return `amable-app-${appId}`;
}

/** D1 database of a deployed app (`DB` → `amable-app-timely-db`). */
export function appDatabaseName(appId: string, binding: string): string {
  return `${appWorkerName(appId)}-${binding.toLowerCase().replace(/_/g, '-')}`;
}

export function appEndpointUrl(manifest: Pick<AppManifest, 'base_url'>, path: string): string {
  return `${manifest.base_url}${path}`;
}

/** Key of a custom field owned by an app: `app_<id>_<key>` (dashes become underscores). */
export function appCustomFieldKey(appId: string, key: string): string {
  return `app_${appId.replace(/-/g, '_')}_${key}`;
}

/** Automation event type fired by an app trigger. */
export function appTriggerEventType(appId: string, key: string): string {
  return `app.${appId}.${key}`;
}

export function localized(text: LocalizedText | { en: string; it?: string | undefined }, locale: string): string {
  return locale === 'it' && text.it !== undefined ? text.it : text.en;
}

/** Scopes requested by `next` that `granted` does not include. */
export function newScopes(granted: readonly string[], next: readonly string[]): string[] {
  const have = new Set(granted);
  return next.filter((scope) => !have.has(scope));
}

export function isSupportedApiVersion(version: string): version is AppApiVersion {
  return (APP_API_VERSIONS as readonly string[]).includes(version);
}
