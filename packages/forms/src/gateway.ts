import type { PublicFormConfig, SubmitPayloadInput, SubmitResult } from './schema';

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
};

export const FORMS_GATEWAY_OPS = ['forms.config', 'forms.hosted', 'forms.submit'] as const;
