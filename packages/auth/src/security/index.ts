/**
 * @amable/auth/security — reusable hardening utilities for later phases:
 * SSRF-safe fetch, HTML/CSS sanitization, sandboxed Liquid. Webhook HMAC
 * signatures and secret encryption live in the main entry (@amable/auth).
 */
export {
  assertSafeUrl,
  isPrivateAddress,
  redactIpAddresses,
  safeFetch,
  SsrfBlockedError,
  ResponseTooLargeError,
} from './ssrf';
export type { HostResolver, SafeFetchOptions, SafeFetchResult, SafeUrlOptions } from './ssrf';
export {
  sanitizeHtml,
  sanitizeEmailDocument,
  sanitizeStyle,
  escapeHtmlText,
  escapeHtmlAttr,
  DEFAULT_ALLOWED_TAGS,
  EMAIL_ALLOWED_TAGS,
  EMAIL_CSS_PROPERTIES,
  SAFE_CSS_PROPERTIES,
} from './sanitize';
export type { SanitizeOptions } from './sanitize';
export { createSandboxedLiquid, renderSandboxed, LIQUID_LIMITS } from './liquid';
export type { SandboxedLiquidOptions } from './liquid';
export {
  signWebhook,
  verifyWebhook,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TOLERANCE_SECONDS,
} from '../webhook';
export type { ReplayGuard, WebhookVerifyFailure } from '../webhook';
export { createSecretBox } from '../crypto';
export type { SecretBox } from '../crypto';
