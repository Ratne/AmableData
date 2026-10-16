import { displayValue, UTM_PARAMS, type FormField } from '@amable/forms';
import type { ZodType } from 'zod';
import type { ConnectorContext } from './types';

/**
 * Merge tags available to connectors: every field key (display value) plus
 * submission facts. `{{key}}` placeholders in templates are replaced with
 * them; unknown tags are left untouched.
 */
export function mergeContext(ctx: ConnectorContext<unknown>): Record<string, string> {
  const { form, submission } = ctx;
  const out: Record<string, string> = {
    submission_id: submission.id,
    form_id: form.id,
    form_name: form.name,
    submitted_at: submission.submittedAt,
    contact_id: submission.contactId ?? '',
    page_url: submission.meta.page_url,
    referrer: submission.meta.referrer,
    visitor_id: submission.meta.visitor_id,
  };
  for (const key of UTM_PARAMS) out[key] = submission.tracking[key] ?? '';
  for (const field of form.fields) {
    const value = submission.values[field.key];
    out[field.key] = value === undefined ? '' : displayValue(field, value);
  }
  return out;
}

export function renderTags(template: string, context: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key: string) =>
    Object.hasOwn(context, key) ? (context[key] ?? '') : match,
  );
}

/** Fields that carry a value, in form order, with their label. */
export function valueFields(fields: readonly FormField[], values: Readonly<Record<string, unknown>>): FormField[] {
  return fields.filter((f) => values[f.key] !== undefined);
}

/** Adapts a Zod schema to `Connector.parseConfig`. */
export function zodConfig<C>(schema: ZodType<C>) {
  return (raw: unknown) => {
    const result = schema.safeParse(raw);
    return result.success
      ? { success: true as const, data: result.data }
      : {
          success: false as const,
          issues: result.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
        };
  };
}
