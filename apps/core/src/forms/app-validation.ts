import type { FormDefinition } from '@amable/forms';
import type { Env } from '../env';
import { validateAndApply, validateContactValues, type AppValidation, type ValidateValues } from '../apps/validate-hook';

/** Email/phone the submission writes to the contact, keyed by the form field that holds them. */
function mapped(definition: FormDefinition, values: Readonly<Record<string, unknown>>): { values: ValidateValues; keys: Record<string, string> } {
  const out: { email?: string; phone?: string } = {};
  const keys: Record<string, string> = {};
  for (const field of definition.fields) {
    if (field.map_to !== 'email' && field.map_to !== 'phone') continue;
    const value = values[field.key];
    if (typeof value !== 'string' || value.trim() === '') continue;
    out[field.map_to] = value;
    keys[field.map_to] = field.key;
  }
  return { values: out, keys };
}

/**
 * Blocking mode: field errors for the values an app marked invalid
 * (`{path: <field key>, message}`); empty when nothing blocks.
 */
export async function blockingValidationErrors(
  env: Env,
  tenantId: string,
  definition: FormDefinition,
  values: Readonly<Record<string, unknown>>,
): Promise<{ path: string; message: string }[]> {
  if (definition.crm.app_validation !== 'blocking' || !definition.crm.create_contacts) return [];
  const { values: contact, keys } = mapped(definition, values);
  if (contact.email === undefined && contact.phone === undefined) return [];
  const results = await validateContactValues(env, tenantId, contact, 'form');
  const errors = new Map<string, string>();
  for (const result of results.filter((r: AppValidation) => r.valid === false)) {
    for (const field of result.fields) {
      const path = keys[field];
      if (path !== undefined && !errors.has(path)) errors.set(path, result.reason ?? 'not valid');
    }
  }
  return [...errors].map(([path, message]) => ({ path, message }));
}

/** Advisory effects (tags, app fields) on the contact the submission created or updated; never throws. */
export async function applyFormValidation(
  env: Env,
  tenantId: string,
  contactId: string,
  definition: FormDefinition,
  values: Readonly<Record<string, unknown>>,
): Promise<void> {
  const { values: contact } = mapped(definition, values);
  if (contact.email === undefined && contact.phone === undefined) return;
  try {
    await validateAndApply(env, tenantId, contactId, contact, 'form');
  } catch (error) {
    console.warn('[forms] app validation failed', error instanceof Error ? error.message : error);
  }
}
