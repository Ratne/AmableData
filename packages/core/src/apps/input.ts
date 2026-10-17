import type { AppInputSchema } from './manifest';

/**
 * Validation of values against an app's input schema (automation action inputs,
 * form connector settings). Shared by the API (at publish time) and the editor
 * (inline errors). Strings with merge tags are accepted as-is for every type.
 */

export type AppInputValue = string | number | boolean;
export type AppInputValues = Record<string, AppInputValue>;

export interface AppInputIssue {
  readonly key: string;
  readonly code: 'required' | 'unknown' | 'type' | 'enum' | 'too_long' | 'range';
}

const MERGE_TAG_RE = /\{\{\s*[a-z_][a-z0-9_.]*\s*\}\}/i;

export function hasMergeTag(value: string): boolean {
  return MERGE_TAG_RE.test(value);
}

export function validateAppInput(schema: AppInputSchema, values: Readonly<Record<string, unknown>>): AppInputIssue[] {
  const issues: AppInputIssue[] = [];
  for (const key of Object.keys(values)) {
    if (!Object.hasOwn(schema.properties, key)) issues.push({ key, code: 'unknown' });
  }
  for (const [key, property] of Object.entries(schema.properties)) {
    const value = values[key];
    if (value === undefined || value === '' || value === null) {
      if ((schema.required ?? []).includes(key)) issues.push({ key, code: 'required' });
      continue;
    }
    const templated = typeof value === 'string' && property.merge_tags === true && hasMergeTag(value);
    if (templated) {
      if (property.max_length !== undefined && (value as string).length > property.max_length * 4) {
        issues.push({ key, code: 'too_long' });
      }
      continue;
    }
    switch (property.type) {
      case 'string': {
        if (typeof value !== 'string') {
          issues.push({ key, code: 'type' });
          break;
        }
        if (property.enum !== undefined && !property.enum.includes(value)) issues.push({ key, code: 'enum' });
        if (value.length > (property.max_length ?? 2000)) issues.push({ key, code: 'too_long' });
        break;
      }
      case 'number':
      case 'integer': {
        if (typeof value !== 'number' || !Number.isFinite(value) || (property.type === 'integer' && !Number.isInteger(value))) {
          issues.push({ key, code: 'type' });
          break;
        }
        if (
          (property.minimum !== undefined && value < property.minimum) ||
          (property.maximum !== undefined && value > property.maximum)
        ) {
          issues.push({ key, code: 'range' });
        }
        break;
      }
      case 'boolean':
        if (typeof value !== 'boolean') issues.push({ key, code: 'type' });
        break;
    }
  }
  return issues;
}

/** Defaults of the schema merged under the given values. */
export function withInputDefaults(schema: AppInputSchema, values: Readonly<Record<string, unknown>>): AppInputValues {
  const out: AppInputValues = {};
  for (const [key, property] of Object.entries(schema.properties)) {
    const value = values[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else if (property.default !== undefined) out[key] = property.default;
  }
  return out;
}
