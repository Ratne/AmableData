import type { BookingAnswer, BookingAnswers, BookingQuestion, PhoneMode } from './types';

/**
 * Validation of the invitee fields and custom answers, shared by the widget
 * (inline errors) and the core worker (authoritative check before booking).
 */

export const ANSWER_ERRORS = [
  'required',
  'invalid_email',
  'invalid_phone',
  'invalid_number',
  'invalid_option',
  'too_long',
  'invalid_value',
] as const;
export type AnswerError = (typeof ANSWER_ERRORS)[number];

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const PHONE_RE = /^\+?[0-9 ().-]{6,30}$/;

const MAX_TEXT = 255;
const MAX_LONG_TEXT = 5000;

export interface InviteeInput {
  readonly given_name: string;
  readonly family_name: string;
  readonly email: string;
  readonly phone: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: Record<string, AnswerError> };

export function validateInvitee(input: InviteeInput, phoneMode: PhoneMode): ValidationResult<InviteeInput> {
  const errors: Record<string, AnswerError> = {};
  const given = input.given_name.trim();
  const family = input.family_name.trim();
  const email = input.email.trim().toLowerCase();
  const phone = phoneMode === 'hidden' ? '' : input.phone.trim();
  if (given === '') errors['given_name'] = 'required';
  else if (given.length > 100) errors['given_name'] = 'too_long';
  if (family.length > 100) errors['family_name'] = 'too_long';
  if (email === '') errors['email'] = 'required';
  else if (email.length > 254 || !EMAIL_RE.test(email)) errors['email'] = 'invalid_email';
  if (phone === '' && phoneMode === 'required') errors['phone'] = 'required';
  else if (phone !== '' && !PHONE_RE.test(phone)) errors['phone'] = 'invalid_phone';
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { given_name: given, family_name: family, email, phone } };
}

function isBlank(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === false ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0)
  );
}

function answerOf(question: BookingQuestion, raw: unknown): { value: BookingAnswer } | { error: AnswerError } {
  switch (question.kind) {
    case 'checkbox':
      if (typeof raw === 'boolean') return { value: raw };
      if (raw === 'true' || raw === 'on' || raw === '1') return { value: true };
      return { error: 'invalid_value' };
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : Number.NaN;
      return Number.isFinite(n) ? { value: n } : { error: 'invalid_number' };
    }
    case 'multicheck': {
      const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : null;
      if (list === null || !list.every((v): v is string => typeof v === 'string')) return { error: 'invalid_value' };
      if (!list.every((v) => question.options.includes(v))) return { error: 'invalid_option' };
      return { value: [...new Set(list)] };
    }
    default: {
      if (typeof raw !== 'string' && typeof raw !== 'number') return { error: 'invalid_value' };
      const text = String(raw).trim();
      if (question.kind === 'select') return question.options.includes(text) ? { value: text } : { error: 'invalid_option' };
      if (question.kind === 'phone' && !PHONE_RE.test(text)) return { error: 'invalid_phone' };
      if (text.length > (question.kind === 'textarea' ? MAX_LONG_TEXT : MAX_TEXT)) return { error: 'too_long' };
      return { value: text };
    }
  }
}

/** Keeps only answers of known questions; unknown keys are dropped. */
export function validateAnswers(
  questions: readonly BookingQuestion[],
  answers: Readonly<Record<string, unknown>>,
): ValidationResult<BookingAnswers> {
  const errors: Record<string, AnswerError> = {};
  const values: BookingAnswers = {};
  for (const question of questions) {
    const raw = answers[question.key];
    if (isBlank(raw)) {
      if (question.required) errors[question.key] = 'required';
      continue;
    }
    const result = answerOf(question, raw);
    if ('error' in result) errors[question.key] = result.error;
    else values[question.key] = result.value;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: values };
}
