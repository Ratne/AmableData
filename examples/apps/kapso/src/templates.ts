import type { MetaTemplate, MetaTemplateComponent } from './kapso';

/**
 * WhatsApp message templates (Meta format) as the CRM sees them: one id, a
 * text with `{{key}}` placeholders and the parameters the team fills in.
 *
 * Keys: body and named header parameters keep their name (`{{1}}` for
 * positional ones), a positional header parameter becomes `header_1`, a media
 * header `header_url`, a dynamic URL or copy-code button `button_<index>`.
 */

export interface CrmTemplate {
  readonly id: string;
  readonly name: string;
  readonly language: string | null;
  readonly category: string | null;
  readonly text: string;
  readonly params: Array<{ key: string; example: string | null }>;
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]{1,64})\s*\}\}/g;
const MEDIA_HEADERS = new Set(['IMAGE', 'VIDEO', 'DOCUMENT']);
const UNSUPPORTED_BUTTONS = new Set(['CATALOG', 'MPM', 'FLOW', 'SPM']);

const component = (template: MetaTemplate, type: string) =>
  template.components.find((c) => c.type.toUpperCase() === type);
const placeholders = (text: string | undefined) =>
  [...(text ?? '').matchAll(PLACEHOLDER)].map((m) => m[1]!);
const named = (template: MetaTemplate) =>
  template.parameter_format?.toUpperCase() === 'NAMED' ||
  [
    ...placeholders(component(template, 'BODY')?.text),
    ...placeholders(component(template, 'HEADER')?.text),
  ].some((p) => !/^\d+$/.test(p));

function examplesOf(
  part: MetaTemplateComponent | undefined,
  kind: 'body' | 'header',
): Map<string, string> {
  const out = new Map<string, string>();
  const example = part?.example ?? {};
  const namedList = example[`${kind}_text_named_params`];
  if (Array.isArray(namedList)) {
    for (const item of namedList as Array<{ param_name?: string; example?: string }>) {
      if (typeof item.param_name === 'string' && typeof item.example === 'string')
        out.set(item.param_name, item.example);
    }
  }
  const positional = example[`${kind}_text`];
  const row = Array.isArray(positional)
    ? Array.isArray(positional[0])
      ? positional[0]
      : positional
    : [];
  (row as unknown[]).forEach((value, i) => {
    if (typeof value === 'string') out.set(String(i + 1), value);
  });
  return out;
}

function headerKey(template: MetaTemplate, placeholder: string): string {
  return named(template) ? placeholder : `header_${placeholder}`;
}

/** Templates the CRM can send: approved, with no catalog, flow or location parts. */
export function sendable(template: MetaTemplate): boolean {
  if (template.status.toUpperCase() !== 'APPROVED') return false;
  const header = component(template, 'HEADER');
  if (header !== undefined && (header.format ?? 'TEXT').toUpperCase() === 'LOCATION') return false;
  return !(component(template, 'BUTTONS')?.buttons ?? []).some((b) =>
    UNSUPPORTED_BUTTONS.has(b.type.toUpperCase()),
  );
}

export function toCrmTemplate(template: MetaTemplate): CrmTemplate {
  const header = component(template, 'HEADER');
  const body = component(template, 'BODY');
  const footer = component(template, 'FOOTER');
  const params: Array<{ key: string; example: string | null }> = [];
  const add = (key: string, example: string | null) => {
    if (!params.some((p) => p.key === key)) params.push({ key, example });
  };
  const parts: string[] = [];
  const headerFormat = (header?.format ?? 'TEXT').toUpperCase();
  if (header !== undefined && headerFormat === 'TEXT' && header.text !== undefined) {
    const examples = examplesOf(header, 'header');
    for (const p of placeholders(header.text)) add(headerKey(template, p), examples.get(p) ?? null);
    parts.push(
      header.text.replace(PLACEHOLDER, (_m, p: string) => `{{${headerKey(template, p)}}}`),
    );
  } else if (header !== undefined && MEDIA_HEADERS.has(headerFormat)) {
    add('header_url', null);
    parts.push(`[${headerFormat.toLowerCase()}: {{header_url}}]`);
  }
  if (body?.text !== undefined) {
    const examples = examplesOf(body, 'body');
    for (const p of placeholders(body.text)) add(p, examples.get(p) ?? null);
    parts.push(body.text);
  }
  if (footer?.text !== undefined) parts.push(footer.text);
  (component(template, 'BUTTONS')?.buttons ?? []).forEach((button, i) => {
    const type = button.type.toUpperCase();
    if ((type === 'URL' && placeholders(button.url).length > 0) || type === 'COPY_CODE')
      add(`button_${String(i)}`, null);
  });
  return {
    id: template.id,
    name: template.name,
    language: template.language,
    category: template.category,
    text: parts.join('\n\n').slice(0, 4096),
    params: params.slice(0, 20),
  };
}

/**
 * The `template` object of a send request, or the parameters still missing.
 * https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-message-templates
 */
export function templateMessage(
  template: MetaTemplate,
  params: Readonly<Record<string, string>>,
):
  { ok: true; template: Record<string, unknown>; text: string } | { ok: false; missing: string[] } {
  const crm = toCrmTemplate(template);
  const value = (key: string) => (params[key] ?? '').trim();
  const missing = crm.params.map((p) => p.key).filter((key) => value(key) === '');
  if (missing.length > 0) return { ok: false, missing };
  const isNamed = named(template);
  const text = (key: string, placeholder: string) => ({
    type: 'text',
    ...(isNamed ? { parameter_name: placeholder } : {}),
    text: value(key),
  });
  const components: Record<string, unknown>[] = [];
  const header = component(template, 'HEADER');
  const headerFormat = (header?.format ?? 'TEXT').toUpperCase();
  if (header !== undefined && headerFormat === 'TEXT' && placeholders(header.text).length > 0) {
    components.push({
      type: 'header',
      parameters: placeholders(header.text).map((p) => text(headerKey(template, p), p)),
    });
  } else if (header !== undefined && MEDIA_HEADERS.has(headerFormat)) {
    const media = headerFormat.toLowerCase();
    components.push({
      type: 'header',
      parameters: [{ type: media, [media]: { link: value('header_url') } }],
    });
  }
  const unique = [...new Set(placeholders(component(template, 'BODY')?.text))];
  // Positional values go in index order, whatever order the text uses them in.
  const bodyParams = isNamed ? unique : unique.sort((a, b) => Number(a) - Number(b));
  if (bodyParams.length > 0)
    components.push({ type: 'body', parameters: bodyParams.map((p) => text(p, p)) });
  (component(template, 'BUTTONS')?.buttons ?? []).forEach((button, index) => {
    const type = button.type.toUpperCase();
    if (type === 'URL' && placeholders(button.url).length > 0) {
      components.push({
        type: 'button',
        sub_type: 'url',
        index: String(index),
        parameters: [{ type: 'text', text: value(`button_${String(index)}`) }],
      });
    } else if (type === 'COPY_CODE') {
      components.push({
        type: 'button',
        sub_type: 'copy_code',
        index: String(index),
        parameters: [{ type: 'coupon_code', coupon_code: value(`button_${String(index)}`) }],
      });
    } else if (type === 'OTP') {
      // Authentication templates repeat the code of the body in the button.
      components.push({
        type: 'button',
        sub_type: 'url',
        index: String(index),
        parameters: [{ type: 'text', text: value(bodyParams[0] ?? '1') }],
      });
    }
  });
  const rendered = crm.text.replace(PLACEHOLDER, (match, key: string) =>
    value(key) === '' ? match : value(key),
  );
  return {
    ok: true,
    template: {
      name: template.name,
      language: { code: template.language },
      ...(components.length > 0 ? { components } : {}),
    },
    text: rendered,
  };
}

/** `key=value` (or `key: value`) per line, as typed in the automation block. */
export function parseParams(raw: unknown): Record<string, string> {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).filter(([, v]) => typeof v === 'string'),
    ) as Record<string, string>;
  }
  if (typeof raw !== 'string') return {};
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_]{1,64})\s*[=:]\s*(.*)$/);
    if (match !== null) out[match[1]!] = match[2]!.trim();
  }
  return out;
}

export const TEMPLATE_CATEGORIES = ['MARKETING', 'UTILITY', 'AUTHENTICATION'] as const;

export interface TemplateDraft {
  readonly name: string;
  readonly language: string;
  readonly category: string;
  readonly header?: string;
  readonly body?: string;
  readonly footer?: string;
  readonly examples?: Readonly<Record<string, string>>;
  readonly buttons?: ReadonlyArray<{
    type: string;
    text: string;
    url?: string;
    phone_number?: string;
    example?: string;
  }>;
  /** Authentication templates. */
  readonly security_recommendation?: boolean;
  readonly code_expiration_minutes?: number;
}

/**
 * Meta's create request for a draft from the templates page (named
 * parameters), or what is wrong with it. Meta reviews it after this.
 */
export function createRequest(
  draft: TemplateDraft,
): { ok: true; request: Record<string, unknown> } | { ok: false; error: string } {
  const name = draft.name.trim();
  if (!/^[a-z0-9_]{1,512}$/.test(name))
    return { ok: false, error: 'name: lowercase letters, digits and underscores only' };
  if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(draft.language))
    return { ok: false, error: 'language: a code such as it, en_US, pt_BR' };
  const category = draft.category.toUpperCase();
  if (!(TEMPLATE_CATEGORIES as readonly string[]).includes(category))
    return { ok: false, error: 'category: MARKETING, UTILITY or AUTHENTICATION' };
  if (category === 'AUTHENTICATION') {
    const minutes = draft.code_expiration_minutes;
    if (minutes !== undefined && (!Number.isInteger(minutes) || minutes < 1 || minutes > 90))
      return { ok: false, error: 'code expiration: 1 to 90 minutes' };
    return {
      ok: true,
      request: {
        name,
        language: draft.language,
        category,
        components: [
          { type: 'BODY', add_security_recommendation: draft.security_recommendation === true },
          ...(minutes === undefined ? [] : [{ type: 'FOOTER', code_expiration_minutes: minutes }]),
          { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE' }] },
        ],
      },
    };
  }
  const body = (draft.body ?? '').trim();
  if (body === '' || body.length > 1024) return { ok: false, error: 'body: 1 to 1024 characters' };
  const examples = draft.examples ?? {};
  const example = (param: string) => (examples[param] ?? '').trim();
  const bodyParams = [...new Set(placeholders(body))];
  const badParam = bodyParams.find((p) => !/^[a-z_][a-z0-9_]*$/.test(p));
  if (badParam !== undefined)
    return {
      ok: false,
      error: `body: parameter {{${badParam}}} must be lowercase letters, digits and underscores`,
    };
  const noExample = bodyParams.find((p) => example(p) === '');
  if (noExample !== undefined)
    return { ok: false, error: `body: Meta needs an example for {{${noExample}}}` };
  const components: Record<string, unknown>[] = [];
  const header = (draft.header ?? '').trim();
  if (header !== '') {
    const headerParams = placeholders(header);
    if (header.length > 60) return { ok: false, error: 'header: at most 60 characters' };
    if (headerParams.length > 1) return { ok: false, error: 'header: at most one parameter' };
    if (headerParams[0] !== undefined && example(headerParams[0]) === '')
      return { ok: false, error: `header: Meta needs an example for {{${headerParams[0]}}}` };
    components.push({
      type: 'HEADER',
      format: 'TEXT',
      text: header,
      ...(headerParams[0] === undefined
        ? {}
        : {
            example: {
              header_text_named_params: [
                { param_name: headerParams[0], example: example(headerParams[0]) },
              ],
            },
          }),
    });
  }
  components.push({
    type: 'BODY',
    text: body,
    ...(bodyParams.length === 0
      ? {}
      : {
          example: {
            body_text_named_params: bodyParams.map((p) => ({ param_name: p, example: example(p) })),
          },
        }),
  });
  const footer = (draft.footer ?? '').trim();
  if (footer !== '') {
    if (footer.length > 60 || placeholders(footer).length > 0)
      return { ok: false, error: 'footer: at most 60 characters, no parameters' };
    components.push({ type: 'FOOTER', text: footer });
  }
  const buttons: Record<string, unknown>[] = [];
  for (const button of draft.buttons ?? []) {
    const type = button.type.toUpperCase();
    const text = button.text.trim();
    if (text === '' || text.length > 25)
      return { ok: false, error: 'buttons: labels of 1 to 25 characters' };
    if (type === 'QUICK_REPLY') buttons.push({ type, text });
    else if (type === 'URL') {
      const url = (button.url ?? '').trim();
      if (!/^https:\/\/\S+$/.test(url))
        return { ok: false, error: 'buttons: links must start with https://' };
      const dynamic = /\{\{1\}\}$/.test(url);
      if (dynamic && (button.example ?? '').trim() === '')
        return { ok: false, error: 'buttons: Meta needs an example for the end of a dynamic link' };
      buttons.push({
        type,
        text,
        url,
        ...(dynamic ? { example: [url.replace('{{1}}', button.example!.trim())] } : {}),
      });
    } else if (type === 'PHONE_NUMBER') {
      const phone = (button.phone_number ?? '').trim();
      if (!/^\+\d{8,15}$/.test(phone))
        return {
          ok: false,
          error: 'buttons: phone numbers in international format, e.g. +393331234567',
        };
      buttons.push({ type, text, phone_number: phone });
    } else return { ok: false, error: `buttons: unsupported type ${type}` };
  }
  if (buttons.length > 10) return { ok: false, error: 'buttons: at most 10' };
  if (buttons.length > 0) components.push({ type: 'BUTTONS', buttons });
  return {
    ok: true,
    request: { name, language: draft.language, category, parameter_format: 'NAMED', components },
  };
}
