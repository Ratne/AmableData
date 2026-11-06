import { z } from 'zod';
import { idSchema, timestampSchema } from '../crm/common';

/**
 * Short links REST v2 schemas: links served on dedicated domains
 * (`domains.kind = 'shortlink'`), flat folders optionally bound to one or more
 * of those domains, and per-link click statistics (aggregated per day in the
 * tenant database).
 */

/** Path segment of a short link on its domain. */
export const SHORTLINK_KEY_RE = /^[a-zA-Z0-9_-]{1,64}$/;
/** Length of generated keys (base62). */
export const SHORTLINK_RANDOM_KEY_LENGTH = 7;
export const SHORTLINK_STATS_MAX_DAYS = 90;
export const SHORTLINK_STATS_DEFAULT_DAYS = 30;
export const SHORTLINK_FOLDER_NAME_MAX = 120;

export const SHORTLINK_UTM_FIELDS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
] as const;
export type ShortlinkUtmField = (typeof SHORTLINK_UTM_FIELDS)[number];

const httpUrlSchema = z
  .string()
  .trim()
  .max(2000)
  .url()
  .refine((v) => /^https?:\/\//i.test(v), 'expected an http(s) URL');

const utmSchema = z.string().trim().max(200).nullable().optional();

export const shortlinkKeySchema = z
  .string()
  .trim()
  .regex(SHORTLINK_KEY_RE, 'letters, digits, - and _ only (max 64)');

export const shortlinkSchema = z.object({
  id: idSchema,
  domain_id: idSchema,
  /** Hostname of the domain; null when the domain no longer exists. */
  hostname: z.string().nullable(),
  folder_id: idSchema.nullable(),
  key: z.string(),
  /** `https://<hostname>/<key>`; null when the domain no longer exists. */
  short_url: z.string().nullable(),
  url: z.string(),
  title: z.string().nullable(),
  utm_source: z.string().nullable(),
  utm_medium: z.string().nullable(),
  utm_campaign: z.string().nullable(),
  utm_term: z.string().nullable(),
  utm_content: z.string().nullable(),
  /** Query parameters of the visit are appended to the destination (they win over the saved UTM). */
  pass_query: z.boolean(),
  expires_at: timestampSchema.nullable(),
  /** Where expired visits go; null = 404. */
  expired_url: z.string().nullable(),
  og_title: z.string().nullable(),
  og_description: z.string().nullable(),
  og_image: z.string().nullable(),
  archived: z.boolean(),
  clicks: z.number().int(),
  /** User who created the link (null for API keys / removed users). */
  created_by: z.string().nullable(),
  created_by_name: z.string().nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type Shortlink = z.infer<typeof shortlinkSchema>;

export const shortlinkListSchema = z.object({ data: z.array(shortlinkSchema) });
export type ShortlinkList = z.infer<typeof shortlinkListSchema>;

export const shortlinkListQuerySchema = z.object({
  /** A folder id, or `none` for links without folder. Omitted: every link. */
  folder_id: z.union([z.literal('none'), idSchema]).optional(),
  domain_id: idSchema.optional(),
  /** Matches key, URL, title. */
  q: z.string().trim().max(200).optional(),
  include_archived: z.enum(['true', 'false']).optional(),
});
export type ShortlinkListQuery = z.infer<typeof shortlinkListQuerySchema>;

const linkFields = {
  folder_id: idSchema.nullable().optional(),
  url: httpUrlSchema,
  title: z.string().trim().max(300).nullable().optional(),
  utm_source: utmSchema,
  utm_medium: utmSchema,
  utm_campaign: utmSchema,
  utm_term: utmSchema,
  utm_content: utmSchema,
  pass_query: z.boolean().optional(),
  expires_at: z.iso.datetime({ offset: true }).nullable().optional(),
  expired_url: httpUrlSchema.nullable().optional(),
  og_title: z.string().trim().max(300).nullable().optional(),
  og_description: z.string().trim().max(600).nullable().optional(),
  og_image: httpUrlSchema.nullable().optional(),
  archived: z.boolean().optional(),
};

export const createShortlinkSchema = z.strictObject({
  domain_id: idSchema,
  /** Omitted or empty: a random 7-character key. */
  key: z.union([shortlinkKeySchema, z.literal('')]).optional(),
  ...linkFields,
});
export type CreateShortlinkInput = z.infer<typeof createShortlinkSchema>;

export const updateShortlinkSchema = z.strictObject({
  domain_id: idSchema.optional(),
  key: shortlinkKeySchema.optional(),
  ...linkFields,
  url: httpUrlSchema.optional(),
});
export type UpdateShortlinkInput = z.infer<typeof updateShortlinkSchema>;

export const shortlinkIdParamSchema = z.object({ id: idSchema });

/** A `shortlink` domain of the workspace (Settings > Domains). */
export const shortlinkDomainSchema = z.object({
  id: idSchema,
  hostname: z.string(),
  status: z.enum(['pending', 'verified', 'failed']),
});
export type ShortlinkDomain = z.infer<typeof shortlinkDomainSchema>;

export const shortlinkDomainListSchema = z.object({ data: z.array(shortlinkDomainSchema) });

// ---------------------------------------------------------------- folders

export const shortlinkFolderSchema = z.object({
  id: idSchema,
  name: z.string(),
  /** Shortlink domains of the folder; empty = any domain. */
  domain_ids: z.array(idSchema),
  link_count: z.number().int(),
  created_at: timestampSchema,
});
export type ShortlinkFolder = z.infer<typeof shortlinkFolderSchema>;

export const shortlinkFolderListSchema = z.object({ data: z.array(shortlinkFolderSchema) });

const folderNameSchema = z.string().trim().min(1).max(SHORTLINK_FOLDER_NAME_MAX);

export const createShortlinkFolderSchema = z.strictObject({
  name: folderNameSchema,
  domain_ids: z.array(idSchema).max(50).optional(),
});
export type CreateShortlinkFolderInput = z.infer<typeof createShortlinkFolderSchema>;

export const updateShortlinkFolderSchema = z.strictObject({
  name: folderNameSchema.optional(),
  domain_ids: z.array(idSchema).max(50).optional(),
});
export type UpdateShortlinkFolderInput = z.infer<typeof updateShortlinkFolderSchema>;

// ------------------------------------------------------------------ stats

export const shortlinkStatsQuerySchema = z.object({
  days: z.coerce
    .number()
    .int()
    .min(1)
    .max(SHORTLINK_STATS_MAX_DAYS)
    .default(SHORTLINK_STATS_DEFAULT_DAYS),
});

const countRow = z.object({ value: z.string(), clicks: z.number().int() });

export const shortlinkStatsSchema = z.object({
  days: z.number().int(),
  /** Lifetime clicks (counter, humans and bots). */
  total_clicks: z.number().int(),
  /** In the period. */
  human_clicks: z.number().int(),
  bot_clicks: z.number().int(),
  /** One entry per day of the period (UTC, YYYY-MM-DD), oldest first. */
  series: z.array(z.object({ day: z.string(), humans: z.number().int(), bots: z.number().int() })),
  /** Human clicks only; `value` is empty when unknown. */
  countries: z.array(countRow),
  referrers: z.array(countRow),
  devices: z.array(countRow),
  browsers: z.array(countRow),
});
export type ShortlinkStats = z.infer<typeof shortlinkStatsSchema>;

// ------------------------------------------------------- edge gateway ops

/**
 * Installation-level (ref `{ host }`): a verified shortlink domain answers with
 * its tenant (envelope) and domain id; any other hostname is a 404.
 */
export const SHORTLINK_HOST_GATEWAY_OP = 'shortlinks.host';
/** Tenant ops (ref `{ slug }` of the tenant returned by the host lookup). */
export const SHORTLINK_RESOLVE_GATEWAY_OP = 'shortlinks.resolve_link';
export const SHORTLINK_CLICK_GATEWAY_OP = 'shortlinks.click';

export interface ShortlinkHostValue {
  readonly domainId: string;
}

/** What the edge needs to answer a visit. */
export interface ShortlinkTarget {
  readonly id: string;
  readonly url: string;
  readonly utm: Partial<Record<ShortlinkUtmField, string>>;
  readonly passQuery: boolean;
  /** Epoch ms. */
  readonly expiresAt: number | null;
  readonly expiredUrl: string | null;
  readonly ogTitle: string | null;
  readonly ogDescription: string | null;
  readonly ogImage: string | null;
}

export interface ShortlinkClickInput {
  readonly linkId: string;
  readonly country: string | null;
  readonly referrerHost: string | null;
  readonly device: string | null;
  readonly browser: string | null;
  readonly os: string | null;
  readonly bot: boolean;
}

export type ShortlinkGatewayOps = {
  [SHORTLINK_HOST_GATEWAY_OP]: { input: Record<string, never>; output: ShortlinkHostValue };
  [SHORTLINK_RESOLVE_GATEWAY_OP]: {
    input: { domainId: string; key: string };
    output: ShortlinkTarget | null;
  };
  [SHORTLINK_CLICK_GATEWAY_OP]: { input: ShortlinkClickInput; output: { ok: true } };
};
