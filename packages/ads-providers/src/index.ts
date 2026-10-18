/**
 * Pure ad platform clients (Meta, Google Ads, TikTok): OAuth, account and
 * entity listing, spend sync and server-side conversions. Transport and clock
 * are injected, so the same code runs in core (sync cron) and in the edge
 * Durable Object (outbound queue).
 */
export * from './types';
export {
  ProviderError,
  PROVIDER_ERROR_KINDS,
  isProviderError,
  kindForStatus,
  type ProviderErrorKind,
} from './errors';
export {
  normalizeEmail,
  normalizePhone,
  sha256Hex,
  hmacSha256Hex,
  hashEmail,
  hashPhone,
  type NormalizeEmailOptions,
  type NormalizePhoneOptions,
  type HashPhoneOptions,
} from './pii';
export { currencyExponent, decimalToMinor, microsToMinor, minorToMajor } from './money';
export {
  createMetaProvider,
  parseMetaError,
  META_DEFAULT_API_VERSION,
  META_DEFAULT_SCOPES,
} from './meta';
export {
  createGoogleAdsProvider,
  parseGoogleAdsError,
  GOOGLE_ADS_DEFAULT_API_VERSION,
  GOOGLE_ADS_DEFAULT_SCOPES,
} from './google-ads';
export { createTikTokProvider, parseTikTokError, TIKTOK_DEFAULT_API_VERSION } from './tiktok';
export { createFakeProvider, type FakeAdsProvider, type FakeSentConversion } from './fake';

import type { AdPlatform } from '@amable/api-types';
import { createGoogleAdsProvider } from './google-ads';
import { createMetaProvider } from './meta';
import { createTikTokProvider } from './tiktok';
import type { AdsProvider, ProviderConfig } from './types';

/** Real client for a platform. */
export function createProvider(platform: AdPlatform, config: ProviderConfig): AdsProvider {
  switch (platform) {
    case 'meta':
      return createMetaProvider(config);
    case 'google':
      return createGoogleAdsProvider(config);
    case 'tiktok':
      return createTikTokProvider(config);
  }
}
