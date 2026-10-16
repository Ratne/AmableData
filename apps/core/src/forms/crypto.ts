import type { SecretBox } from '@amable/auth';
import { submissionMetaSchema } from '@amable/forms';
import type { SubmissionContent } from './submissions';

/**
 * Encryption at rest of submission values and connection secrets. The
 * associated data binds every ciphertext to its tenant and row: a value copied
 * to another submission or tenant fails to decrypt.
 */

export function submissionAd(tenantId: string, submissionId: string): string {
  return `form-submission:${tenantId}:${submissionId}`;
}

export function connectionAd(tenantId: string, connectionId: string): string {
  return `form-connection:${tenantId}:${connectionId}`;
}

export function encryptSubmission(
  box: SecretBox,
  tenantId: string,
  submissionId: string,
  content: SubmissionContent,
): Promise<string> {
  return box.encrypt(JSON.stringify(content), submissionAd(tenantId, submissionId));
}

export async function decryptSubmission(
  box: SecretBox,
  tenantId: string,
  submissionId: string,
  ciphertext: string,
): Promise<SubmissionContent> {
  const parsed = JSON.parse(await box.decrypt(ciphertext, submissionAd(tenantId, submissionId))) as Partial<SubmissionContent>;
  return {
    values: parsed.values ?? {},
    tracking: parsed.tracking ?? {},
    meta: submissionMetaSchema.parse(parsed.meta ?? {}),
  };
}

export function encryptSecret(box: SecretBox, tenantId: string, connectionId: string, secret: string): Promise<string> {
  return box.encrypt(secret, connectionAd(tenantId, connectionId));
}

export function decryptSecret(
  box: SecretBox,
  tenantId: string,
  connectionId: string,
  ciphertext: string,
): Promise<string> {
  return box.decrypt(ciphertext, connectionAd(tenantId, connectionId));
}

/** Last 4 characters, to recognize a secret without revealing it. */
export function secretHint(secret: string): string {
  return `…${secret.slice(-4)}`;
}
