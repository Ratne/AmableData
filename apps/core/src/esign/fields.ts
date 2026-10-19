import { ESIGN_IMAGE_FIELDS, type EsignField } from '@amable/api-types';
import type { ErrorDetail } from '../crm/errors';
import { isImageValue, type FieldValue, type FieldValues } from './model';

export const TEXT_VALUE_MAX = 1000;
const NUMBER_RE = /^-?\d{1,15}(?:[.,]\d{1,6})?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function validDate(value: string): boolean {
  const match = DATE_RE.exec(value);
  if (match === null) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

function isEmpty(value: FieldValue | undefined): boolean {
  return value === undefined || value === '' || value === false;
}

/**
 * Checks the values one party submits for its own fields and returns the
 * normalized set: unknown keys are dropped, `signed_date` is filled with the
 * signing day, empty optional fields are omitted.
 */
/**
 * `YYYY-MM-DD` of `now` in the signer's browser time zone, the date the
 * signing page showed for `signed_date` fields; UTC when the zone is unknown.
 */
export function signingDay(now: number, timeZone: unknown): string {
  if (typeof timeZone === 'string' && timeZone !== '') {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    } catch {
      // unknown zone name
    }
  }
  return new Date(now).toISOString().slice(0, 10);
}

export function validateValues(
  fields: ReadonlyArray<Pick<EsignField, 'id' | 'type' | 'required' | 'options'>>,
  values: Readonly<Record<string, unknown>>,
  signedDate: string,
): { values: FieldValues; errors: ErrorDetail[] } {
  const out: FieldValues = {};
  const errors: ErrorDetail[] = [];
  for (const field of fields) {
    const path = `values.${field.id}`;
    if (field.type === 'signed_date') {
      out[field.id] = signedDate;
      continue;
    }
    const raw = values[field.id] as FieldValue | undefined;
    if (isEmpty(raw)) {
      if (field.required) errors.push({ path, message: 'required' });
      continue;
    }
    if (ESIGN_IMAGE_FIELDS.has(field.type)) {
      if (!isImageValue(raw)) errors.push({ path, message: 'expected an image' });
      else out[field.id] = raw;
      continue;
    }
    if (field.type === 'checkbox') {
      if (typeof raw !== 'boolean') errors.push({ path, message: 'expected true or false' });
      else out[field.id] = raw;
      continue;
    }
    if (typeof raw !== 'string') {
      errors.push({ path, message: 'expected text' });
      continue;
    }
    const text = raw.trim();
    if (text.length > TEXT_VALUE_MAX) {
      errors.push({ path, message: `at most ${String(TEXT_VALUE_MAX)} characters` });
    } else if (field.type === 'number' && !NUMBER_RE.test(text)) {
      errors.push({ path, message: 'expected a number' });
    } else if (field.type === 'date' && !validDate(text)) {
      errors.push({ path, message: 'expected a date (YYYY-MM-DD)' });
    } else if (
      (field.type === 'select' || field.type === 'radio') &&
      !field.options.includes(text)
    ) {
      errors.push({ path, message: 'not one of the options' });
    } else if (text === '') {
      if (field.required) errors.push({ path, message: 'required' });
    } else {
      out[field.id] = text;
    }
  }
  return { values: out, errors };
}
