import type {
  AdEntity,
  AdEntityLevel,
  AdPlatform,
  AdSpendDay,
  OutboundConversionJob,
} from '@amable/api-types';

export interface ProviderConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Google Ads only. */
  readonly developerToken?: string;
  /** Google Ads only: manager (MCC) account the calls are made through, digits. */
  readonly loginCustomerId?: string;
  /** Platform API version, e.g. `v23.0` (Meta), `v22` (Google Ads), `v1.3` (TikTok). */
  readonly apiVersion?: string;
  readonly fetch: typeof fetch;
  /** Epoch ms. */
  readonly now: () => number;
}

export interface AuthorizeUrlInput {
  readonly redirectUri: string;
  readonly state: string;
  readonly scopes?: readonly string[];
}

export interface ExchangeCodeInput {
  readonly code: string;
  readonly redirectUri: string;
}

export interface OAuthTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** Epoch ms; absent when the platform token does not expire. */
  readonly expiresAt?: number;
}

export interface AdAccountInfo {
  readonly account_id: string;
  readonly name: string;
  /** ISO 4217, upper case. */
  readonly currency: string;
  /** IANA time zone of the account (its "day" boundary). */
  readonly timezone: string;
}

export const SPEND_GRANULARITIES = ['day', 'hour'] as const;
export type SpendGranularity = (typeof SPEND_GRANULARITIES)[number];

export interface SpendQuery {
  /** Inclusive account-local days, `YYYY-MM-DD`. */
  readonly from: string;
  readonly to: string;
  readonly granularity: SpendGranularity;
  readonly level: AdEntityLevel;
}

/** `AdSpendDay` plus the hour of the day (0–23) when `granularity: 'hour'`. */
export type AdSpendRow = AdSpendDay & { readonly hour?: number };

export interface SendConversionOptions {
  /** Meta: dataset (pixel) the events go to; `pixelId` and `datasetId` are synonyms. */
  readonly pixelId?: string;
  readonly datasetId?: string;
  /** Google: conversion action id or resource name `customers/<id>/conversionActions/<id>`. */
  readonly conversionAction?: string;
  /** Google: customer the conversion is uploaded to (digits, dashes allowed). */
  readonly customerId?: string;
  /** TikTok: pixel code (`event_source_id`). */
  readonly pixelCode?: string;
  /** Meta / TikTok test events code, routes events to the platform's test tool. */
  readonly testEventCode?: string;
  /** Calling code applied to phone numbers without international prefix, e.g. `39`. */
  readonly defaultCallingCode?: string;
}

export interface SendConversionResult {
  readonly ok: true;
  readonly platformResponseId?: string;
}

/** Common surface of every ad platform client. All methods throw `ProviderError`. */
export interface AdsProvider {
  readonly platform: AdPlatform;
  authorizeUrl(input: AuthorizeUrlInput): string;
  exchangeCode(input: ExchangeCodeInput): Promise<OAuthTokens>;
  refreshToken(refreshToken: string): Promise<OAuthTokens>;
  listAccounts(accessToken: string): Promise<AdAccountInfo[]>;
  listEntities(accessToken: string, accountId: string): Promise<AdEntity[]>;
  fetchSpend(accessToken: string, accountId: string, query: SpendQuery): Promise<AdSpendRow[]>;
  sendConversion(
    accessToken: string,
    job: OutboundConversionJob,
    options: SendConversionOptions,
  ): Promise<SendConversionResult>;
}
