import { z } from 'zod';
import { CONTACT_MAP_TARGETS, FIELD_KINDS, OPTION_KINDS, collectsValue } from './constants';

export * from './constants';

/**
 * Form definition: the JSON document edited by the form builder, stored on the
 * form row and served (without the CRM part) to the embeddable widget.
 *
 * Fields are an ordered list; `page_break` fields split the form into steps
 * (the label of a break is the title of the step that follows it).
 */

export const fieldKindSchema = z.enum(FIELD_KINDS);

const CUSTOM_MAP_RE = /^custom\.[a-z][a-z0-9_]{0,62}$/;

export const mapToSchema = z
  .union([z.enum(CONTACT_MAP_TARGETS), z.string().regex(CUSTOM_MAP_RE, 'expected custom.<key>')])
  .nullable();
export type MapTo = z.infer<typeof mapToSchema>;

export const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,62}$/;

export const CONDITION_OPS = ['equals', 'not_equals', 'contains', 'any_of', 'filled', 'empty'] as const;
export const conditionOpSchema = z.enum(CONDITION_OPS);
export type ConditionOp = z.infer<typeof conditionOpSchema>;

/** A field is shown only when every rule holds (AND). */
export const visibilityRuleSchema = z.object({
  field_key: z.string().regex(FIELD_KEY_RE),
  op: conditionOpSchema,
  /** Ignored by `filled` / `empty`; comma-separated list for `any_of`. */
  value: z.string().max(500).default(''),
});
export type VisibilityRule = z.infer<typeof visibilityRuleSchema>;

export const fieldOptionSchema = z.object({
  label: z.string().trim().min(1).max(200),
  value: z.string().trim().min(1).max(200),
});
export type FieldOption = z.infer<typeof fieldOptionSchema>;

export const formFieldSchema = z.object({
  id: z.string().min(1).max(64),
  kind: fieldKindSchema,
  /** Name of the value in the submission (and merge tag in connections). */
  key: z.string().regex(FIELD_KEY_RE, 'lowercase letters, digits and underscores'),
  label: z.string().max(500).default(''),
  description: z.string().max(2000).default(''),
  placeholder: z.string().max(200).default(''),
  required: z.boolean().default(false),
  options: z.array(fieldOptionSchema).max(200).default([]),
  /** number: bounds of the value. */
  min: z.number().optional(),
  max: z.number().optional(),
  /** text / textarea: maximum length (default 255 / 5000). */
  max_length: z.number().int().min(1).max(10_000).optional(),
  max_rating: z.number().int().min(1).max(10).default(5),
  /** html: static content, sanitized before it reaches the widget. */
  html: z.string().max(20_000).default(''),
  /** hidden: fixed value used when the URL parameter is absent; other kinds: initial value. */
  default_value: z.string().max(1000).default(''),
  /** URL query parameter prefilling the field (hidden fields read their value from it). */
  prefill_param: z.string().regex(/^[A-Za-z0-9_.-]{0,64}$/).default(''),
  /** consent: link shown after the label (privacy policy). */
  link_url: z.union([z.literal(''), z.url({ protocol: /^https?$/ })]).default(''),
  link_text: z.string().max(200).default(''),
  /** consent: a checked box grants email marketing consent (contact becomes single opt-in). */
  marketing: z.boolean().default(false),
  /** Omitted from event payloads, notifications and the submissions list preview. */
  sensitive: z.boolean().default(false),
  width: z.enum(['full', 'half']).default('full'),
  visible_if: z.array(visibilityRuleSchema).max(10).default([]),
  /** Contact attribute written by this field when the submission is processed. */
  map_to: mapToSchema.default(null),
});
export type FormField = z.infer<typeof formFieldSchema>;
export type FormFieldInput = z.input<typeof formFieldSchema>;

/** CSS values injected into the widget stylesheet: no way to close a rule or a tag. */
const cssValue = (fallback: string) =>
  z
    .string()
    .trim()
    .max(200)
    .regex(/^[^{}<>;\\]*$/, 'invalid CSS value')
    .default(fallback);

export const formStyleSchema = z.object({
  primary_color: cssValue('#4f46e5'),
  text_color: cssValue('#111827'),
  background_color: cssValue('transparent'),
  input_background: cssValue('#ffffff'),
  border_color: cssValue('#d1d5db'),
  button_text_color: cssValue('#ffffff'),
  radius: cssValue('8px'),
  font_family: cssValue('system-ui, -apple-system, Segoe UI, sans-serif'),
  font_size: cssValue('15px'),
  gap: cssValue('14px'),
  max_width: cssValue('560px'),
  /** Extra rules, scoped to the widget's shadow root. */
  custom_css: z
    .string()
    .max(20_000)
    .regex(/^[^<]*$/, 'invalid CSS')
    .default(''),
});
export type FormStyle = z.infer<typeof formStyleSchema>;

export const FORM_LOCALES = ['auto', 'en', 'it'] as const;

export const formSettingsSchema = z.object({
  /** Empty: localized default. */
  submit_label: z.string().max(100).default(''),
  next_label: z.string().max(100).default(''),
  back_label: z.string().max(100).default(''),
  success_mode: z.enum(['message', 'redirect']).default('message'),
  success_message: z.string().max(2000).default(''),
  redirect_url: z.union([z.literal(''), z.url({ protocol: /^https?$/ })]).default(''),
  turnstile_enabled: z.boolean().default(false),
  /** Hostnames allowed to embed the form (empty: any). Subdomains match. */
  allowed_domains: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9.-]{1,253}$/),
    )
    .max(50)
    .default([]),
  /** Public page at `/f/<tenant>/<formId>` on the edge. */
  hosted_enabled: z.boolean().default(true),
  locale: z.enum(FORM_LOCALES).default('auto'),
});
export type FormSettings = z.infer<typeof formSettingsSchema>;

export const UPDATE_POLICIES = ['fill_empty', 'overwrite'] as const;
export const APP_VALIDATION_MODES = ['advisory', 'blocking'] as const;

export const formCrmSchema = z.object({
  /** Create (or update) a contact from the mapped fields. */
  create_contacts: z.boolean().default(true),
  /** CRM tags applied to the contact. */
  tag_ids: z.array(z.string().min(1).max(64)).max(50).default([]),
  /** Set on contacts that have none. */
  lead_source_id: z.string().min(1).max(64).nullable().default(null),
  /** Owner of new contacts (and of existing ones without an owner). */
  owner_id: z.string().min(1).max(64).nullable().default(null),
  /** `fill_empty` never replaces existing values; `overwrite` replaces them with the submission. */
  update_policy: z.enum(UPDATE_POLICIES).default('fill_empty'),
  /**
   * Apps that validate email/phone (`contact.validate`): `advisory` only tags or
   * annotates the contact, `blocking` also rejects submissions an app marks invalid.
   * Apps that do not answer in time never block.
   */
  app_validation: z.enum(APP_VALIDATION_MODES).default('advisory'),
});
export type FormCrmSettings = z.infer<typeof formCrmSchema>;

export const formDefinitionSchema = z
  .object({
    fields: z.array(formFieldSchema).max(150).default([]),
    settings: formSettingsSchema.default(() => formSettingsSchema.parse({})),
    style: formStyleSchema.default(() => formStyleSchema.parse({})),
    crm: formCrmSchema.default(() => formCrmSchema.parse({})),
  })
  .superRefine((definition, ctx) => {
    const keys = new Set<string>();
    const ids = new Set<string>();
    const targets = new Set<string>();
    definition.fields.forEach((field, index) => {
      if (ids.has(field.id)) {
        ctx.addIssue({ code: 'custom', path: ['fields', index, 'id'], message: 'duplicate field id' });
      }
      ids.add(field.id);
      if (keys.has(field.key)) {
        ctx.addIssue({ code: 'custom', path: ['fields', index, 'key'], message: 'duplicate field key' });
      }
      keys.add(field.key);
      if (OPTION_KINDS.has(field.kind) && field.options.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['fields', index, 'options'], message: 'add at least one option' });
      }
      if (field.map_to !== null) {
        if (!collectsValue(field.kind)) {
          ctx.addIssue({ code: 'custom', path: ['fields', index, 'map_to'], message: 'this field collects no value' });
        } else if (targets.has(field.map_to)) {
          ctx.addIssue({ code: 'custom', path: ['fields', index, 'map_to'], message: 'another field already maps to this attribute' });
        }
        targets.add(field.map_to);
      }
    });
    definition.fields.forEach((field, index) => {
      field.visible_if.forEach((rule, ruleIndex) => {
        if (!keys.has(rule.field_key) || rule.field_key === field.key) {
          ctx.addIssue({
            code: 'custom',
            path: ['fields', index, 'visible_if', ruleIndex, 'field_key'],
            message: 'unknown field',
          });
        }
      });
    });
  });
export type FormDefinition = z.infer<typeof formDefinitionSchema>;
export type FormDefinitionInput = z.input<typeof formDefinitionSchema>;

/** Starting point of a new form: name, email and a privacy consent. */
export function defaultFormDefinition(locale: 'en' | 'it' = 'en'): FormDefinition {
  const it = locale === 'it';
  return formDefinitionSchema.parse({
    fields: [
      { id: 'f_name', kind: 'text', key: 'first_name', label: it ? 'Nome' : 'First name', required: true, width: 'half', map_to: 'given_name' },
      { id: 'f_last', kind: 'text', key: 'last_name', label: it ? 'Cognome' : 'Last name', width: 'half', map_to: 'family_name' },
      { id: 'f_email', kind: 'email', key: 'email', label: 'Email', required: true, map_to: 'email' },
      {
        id: 'f_privacy',
        kind: 'consent',
        key: 'privacy',
        label: it ? 'Ho letto e accetto la privacy policy' : 'I have read and accept the privacy policy',
        required: true,
      },
    ],
  });
}

// --------------------------------------------------------------- public config

/** What the widget receives: no CRM settings, html already sanitized. */
export interface PublicFormConfig {
  readonly id: string;
  readonly name: string;
  readonly tenant: string;
  readonly fields: readonly FormField[];
  readonly settings: Omit<FormSettings, 'allowed_domains'>;
  readonly style: FormStyle;
  /** Turnstile site key when the form requires the challenge and the installation has one. */
  readonly turnstile_site_key: string | null;
}

// ----------------------------------------------------------------- submission

const shortText = z.string().max(2048).default('');

export const submissionMetaSchema = z.object({
  page_url: shortText,
  referrer: shortText,
  /** First page and referrer of the browsing session (first-touch attribution). */
  landing_url: shortText,
  first_referrer: shortText,
  /** Published amable landing page the form was on. */
  page_id: z.string().max(64).default(''),
  /** Analytics visitor id read from the first-party cookie `amb_vid` (same-site only). */
  visitor_id: z.string().max(64).default(''),
  locale: z.string().max(16).default(''),
  time_zone: z.string().max(64).default(''),
  viewport: z.string().max(20).default(''),
});
export type SubmissionMeta = z.infer<typeof submissionMetaSchema>;

export const submitPayloadSchema = z.object({
  /** Field key → value (string, number, boolean or list of strings). */
  values: z
    .record(
      z.string().max(64),
      z.union([z.string().max(10_000), z.number(), z.boolean(), z.array(z.string().max(200)).max(200), z.null()]),
    )
    .default({}),
  /** Auto-captured parameters (utm_*, click ids). Hidden *fields* travel in `values`. */
  tracking: z.record(z.string().max(64), z.string().max(500)).default({}),
  meta: submissionMetaSchema.default(() => submissionMetaSchema.parse({})),
  /** Honeypot: humans leave it empty. */
  hp: z.string().max(500).default(''),
  elapsed_ms: z.number().int().min(0).max(86_400_000).default(0),
  turnstile_token: z.string().max(4096).default(''),
});
export type SubmitPayload = z.infer<typeof submitPayloadSchema>;
export type SubmitPayloadInput = z.input<typeof submitPayloadSchema>;

export type SubmissionValue = string | number | boolean | string[];
export type SubmissionValues = Record<string, SubmissionValue>;

/** Successful submit answer, shared by the edge and the widget. */
export interface SubmitResult {
  readonly ok: true;
  readonly submission_id: string;
  readonly success_mode: 'message' | 'redirect';
  readonly success_message: string;
  readonly redirect_url: string;
}
