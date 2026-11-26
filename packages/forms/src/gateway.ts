import type { PublicFormConfig, SubmitPayloadInput, SubmitResult } from './schema';

/** One address autocomplete result (same shape as the CRM `AddressSuggestion` of @amable/api-types). */
export interface AddressSuggestion {
  label: string;
  line1: string;
  street_number: string | null;
  locality: string | null;
  region: string | null;
  postal_code: string | null;
  country_code: string | null;
}

/**
 * Edge ↔ core gateway ops of hosted forms (structurally a `GatewayOpMap` of
 * @amable/api-types): the edge serves `/f/:tenant/:formId` and forwards
 * submissions; the core worker validates, encrypts and stores them.
 */
export type FormsGatewayOps = {
  /** Public widget configuration of an active form (404 otherwise). */
  'forms.config': {
    input: { formId: string };
    output: PublicFormConfig;
  };
  /** Hosted page facts: like `forms.config`, 404 when the hosted page is disabled. */
  'forms.hosted': {
    input: { formId: string };
    output: { config: PublicFormConfig; tenantName: string };
  };
  /** Validates (Turnstile, fields) and stores an encrypted submission, then queues its processing. */
  'forms.submit': {
    input: { formId: string; payload: SubmitPayloadInput };
    output: SubmitResult;
  };
  /** Address autocomplete of a form with a field mapped to `address.line1` (empty otherwise). */
  'forms.address': {
    input: { formId: string; q: string; country: string; lang: string };
    output: { data: AddressSuggestion[]; attribution: string | null };
  };
};

export const FORMS_GATEWAY_OPS = ['forms.config', 'forms.hosted', 'forms.submit', 'forms.address'] as const;
