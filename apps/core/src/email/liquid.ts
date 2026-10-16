import type {
  CustomField,
  CustomFieldType,
  LiquidPreview,
  LiquidSchema,
  LiquidSchemaField,
  LiquidValueKind,
} from '@amable/api-types';
import { createSandboxedLiquid, LIQUID_LIMITS } from '@amable/auth/security';
import { liquidFilterNames, liquidIssue, liquidVariablePaths } from '@amable/email-render';
import type { MailSendContact } from '../crm/mail-reads';
import type { TenantUser } from './context';
import { recipientContext, renderSnippetBodies, sampleContext, SNIPPET_RENDER_MS } from './render';

/**
 * Liquid helper backend: the schema of the recipient render context and the
 * live preview of a template for one contact. Both reuse the send pipeline's
 * pieces (`recipientContext`, snippet rendering, the shared sandbox), so the
 * preview shows what a recipient would receive.
 */

type Standard = Pick<LiquidSchemaField, 'path' | 'group' | 'kind' | 'example'>;

/**
 * Every path `recipientContext` produces, plus the per-send additions
 * (`unsubscribe_url`) and the `now` literal. A test keeps this list equal to
 * the keys of the real context.
 */
export const STANDARD_LIQUID_FIELDS: readonly Standard[] = [
  { path: 'contact.id', group: 'contact', kind: 'string', example: '01J…' },
  { path: 'contact.first_name', group: 'contact', kind: 'string', example: 'Ada' },
  { path: 'contact.last_name', group: 'contact', kind: 'string', example: 'Lovelace' },
  { path: 'contact.full_name', group: 'contact', kind: 'string', example: 'Ada Lovelace' },
  { path: 'contact.email', group: 'contact', kind: 'string', example: 'ada@example.com' },
  { path: 'contact.phone', group: 'contact', kind: 'string', example: '+39 02 1234567' },
  { path: 'contact.city', group: 'contact', kind: 'string', example: 'Milano' },
  { path: 'contact.region', group: 'contact', kind: 'string', example: 'MI' },
  { path: 'contact.country', group: 'contact', kind: 'string', example: 'IT' },
  { path: 'contact.job_title', group: 'contact', kind: 'string', example: 'CTO' },
  { path: 'contact.website', group: 'contact', kind: 'url', example: 'https://example.com' },
  { path: 'contact.time_zone', group: 'contact', kind: 'string', example: 'Europe/Rome' },
  { path: 'contact.score', group: 'contact', kind: 'number', example: '72' },
  { path: 'contact.tags', group: 'contact', kind: 'list', example: '["VIP", "Newsletter"]' },
  { path: 'company.name', group: 'company', kind: 'string', example: 'Analytical Engines Srl' },
  { path: 'company.website', group: 'company', kind: 'url', example: 'https://example.com' },
  { path: 'owner.name', group: 'owner', kind: 'string', example: 'Marco Rossi' },
  { path: 'owner.email', group: 'owner', kind: 'string', example: 'marco@example.com' },
  { path: 'owner.signature', group: 'owner', kind: 'string', example: null },
  { path: 'unsubscribe_url', group: 'system', kind: 'url', example: 'https://…/unsub/…' },
  { path: 'now', group: 'system', kind: 'date', example: '"now" | date: "%d/%m/%Y"' },
];

const CUSTOM_KIND: Readonly<Record<CustomFieldType, LiquidValueKind>> = {
  CURRENCY: 'number',
  DATE: 'date',
  DATE_TIME: 'date',
  DAY_OF_WEEK: 'number',
  DECIMAL_NUMBER: 'number',
  DRILLDOWN: 'list',
  DROPDOWN: 'string',
  EMAIL: 'string',
  LIST_BOX: 'list',
  MONTH: 'number',
  NAME: 'string',
  PERCENT: 'number',
  PHONE_NUMBER: 'string',
  RADIO: 'string',
  SOCIAL_SECURITY_NUMBER: 'string',
  STATE: 'string',
  TEXT: 'string',
  TEXT_AREA: 'string',
  USER: 'string',
  USER_LIST_BOX: 'list',
  WEBSITE: 'url',
  WHOLE_NUMBER: 'number',
  YEAR: 'number',
  YES_NO: 'boolean',
};

/** Liquid tags available to templates (`include`/`render`/`layout` find no files in the sandbox). */
export const LIQUID_TAGS = [
  'if',
  'elsif',
  'else',
  'unless',
  'case',
  'when',
  'for',
  'break',
  'continue',
  'cycle',
  'tablerow',
  'assign',
  'capture',
  'increment',
  'decrement',
  'raw',
  'comment',
  'liquid',
  'echo',
] as const;

export function liquidContextSchema(input: {
  readonly customFields: readonly CustomField[];
  readonly snippets: readonly { key: string; name: string }[];
  readonly canReadSensitive: boolean;
}): LiquidSchema {
  const standard = STANDARD_LIQUID_FIELDS.map(
    (field): LiquidSchemaField => ({
      ...field,
      label: null,
      custom_field_type: null,
      options: [],
      masked: false,
    }),
  );
  const custom = input.customFields.map(
    (field): LiquidSchemaField => ({
      path: `contact.custom.${field.key}`,
      group: 'custom',
      kind: CUSTOM_KIND[field.type],
      label: field.label,
      custom_field_type: field.type,
      options: field.options.map((option) => option.value),
      masked: field.sensitive && !input.canReadSensitive,
      example: null,
    }),
  );
  const snippets = input.snippets.map(
    (snippet): LiquidSchemaField => ({
      path: `snippets.${snippet.key}`,
      group: 'snippets',
      kind: 'html',
      label: snippet.name,
      custom_field_type: null,
      options: [],
      masked: false,
      example: null,
    }),
  );
  return {
    fields: [...standard, ...custom, ...snippets],
    filters: liquidFilterNames(),
    tags: [...LIQUID_TAGS],
    limits: {
      template_bytes: LIQUID_LIMITS.parseLimit,
      render_ms: LIQUID_LIMITS.renderLimitMs,
      snippet_render_ms: SNIPPET_RENDER_MS,
      memory_bytes: LIQUID_LIMITS.memoryLimit,
    },
  };
}

const SAMPLE_UNSUBSCRIBE = 'https://example.com/unsub/preview';
const SNIPPET_PATH_RE = /^snippets\.([a-z][a-z0-9_]{0,62})/;

/**
 * Render context of a preview, built like the send pipeline: the recipient
 * context (or sample data), an example unsubscribe URL and the referenced
 * snippets rendered for this recipient.
 */
export async function previewContextFor(input: {
  readonly data: MailSendContact | null;
  readonly owner: TenantUser | null;
  readonly caller: TenantUser;
  readonly snippets: readonly { key: string; body: string }[];
  /** Variable paths of the template, or `all` to render every snippet. */
  readonly variables: readonly string[] | 'all';
  readonly timezone: string;
}): Promise<Record<string, unknown>> {
  const base = input.data === null ? sampleContext(input.caller) : recipientContext(input.data, input.owner);
  const context: Record<string, unknown> = { ...base, unsubscribe_url: SAMPLE_UNSUBSCRIBE };
  const variables = input.variables;
  const keys =
    variables === 'all'
      ? null
      : new Set(variables.map((path) => SNIPPET_PATH_RE.exec(path)?.[1]).filter((k) => k !== undefined));
  context['snippets'] = await renderSnippetBodies(
    input.snippets.filter((s) => keys === null || keys.has(s.key)),
    context,
    input.timezone,
  );
  return context;
}

function lookup(context: Record<string, unknown>, path: string): unknown {
  let current: unknown = context;
  for (const part of path.split('.')) {
    if (Array.isArray(current)) {
      if (part === 'size') return current.length;
      if (part === 'first') current = current[0];
      else if (part === 'last') current = current.at(-1);
      else if (/^\d+$/.test(part)) current = current[Number(part)];
      else return undefined;
      continue;
    }
    if (typeof current === 'string' && part === 'size') return current.length;
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function isBlank(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/** True when the path is (inside) a field of the schema, or an object containing fields. */
function isKnown(path: string, schemaPaths: readonly string[]): boolean {
  return schemaPaths.some(
    (known) => known === path || path.startsWith(`${known}.`) || known.startsWith(`${path}.`),
  );
}

/** Renders a template for a preview: output, positioned errors, used / missing / unknown variables. */
export async function renderLiquidPreview(input: {
  readonly template: string;
  readonly format: 'html' | 'text';
  readonly schemaPaths: readonly string[];
  readonly contextFor: (variables: readonly string[]) => Promise<Record<string, unknown>>;
  readonly contactId: string | null;
  /** Default zone of the `date` filter, as when sending: the tenant timezone. */
  readonly timezone: string;
}): Promise<LiquidPreview> {
  const empty = { variables: [], missing: [], unknown: [], contact_id: input.contactId };
  let variables: string[];
  try {
    variables = liquidVariablePaths(input.template);
  } catch (error) {
    return { ok: false, output: '', errors: [liquidIssue(error)], ...empty };
  }
  const context = await input.contextFor(variables);
  const unknown = variables.filter((path) => !isKnown(path, input.schemaPaths));
  const missing = variables.filter(
    (path) => !unknown.includes(path) && isBlank(lookup(context, path)),
  );
  const engine = createSandboxedLiquid({ escapeHtml: input.format === 'html', timezone: input.timezone });
  try {
    const rendered: unknown = await engine.parseAndRender(input.template, context);
    return {
      ok: true,
      output: typeof rendered === 'string' ? rendered : String(rendered),
      errors: [],
      variables,
      missing,
      unknown,
      contact_id: input.contactId,
    };
  } catch (error) {
    return {
      ok: false,
      output: '',
      errors: [liquidIssue(error)],
      variables,
      missing,
      unknown,
      contact_id: input.contactId,
    };
  }
}
