import { RESERVED_URL_PARAMS } from '@amable/api-types';

/** Values available to `{token}` placeholders in data passing, webhooks and postbacks. */
export interface TokenContext {
  hitId?: string | null;
  visitorId?: string | null;
  campaign?: string | null;
  external?: string | null;
  funnelId?: string | null;
  trafficSourceId?: string | null;
  currentNodeId?: string | null;
  country?: string | null;
  device?: string | null;
  browser?: string | null;
  os?: string | null;
  payout?: string | number | null;
  txid?: string | null;
  /** Custom tracking field values by field name. */
  fields?: Record<string, string>;
  /** Tracking field values by slot (`c1`…`c20`). */
  slots?: Record<string, string>;
  /** Visit data buffer: every URL parameter seen during the visit (never stored). */
  data?: Record<string, string>;
}

export type TokenEncoding = 'url' | 'json' | 'raw';

const SIMPLE_TOKENS = new Map<string, (ctx: TokenContext) => string | number | null | undefined>([
  ['hit', (c) => c.hitId],
  ['visitor', (c) => c.visitorId],
  ['campaign', (c) => c.campaign],
  ['external', (c) => c.external],
  ['funnel-id', (c) => c.funnelId],
  ['trafficsource-id', (c) => c.trafficSourceId],
  ['current-node-id', (c) => c.currentNodeId],
  ['country', (c) => c.country],
  ['device', (c) => c.device],
  ['browser', (c) => c.browser],
  ['os', (c) => c.os],
  ['payout', (c) => c.payout],
  ['txid', (c) => c.txid],
]);

const TOKEN_RE = /\{([A-Za-z0-9_.-]+)\}/g;
const SLOT_RE = /^c(?:[1-9]|1\d|20)$/;

function encode(value: string, encoding: TokenEncoding): string {
  if (encoding === 'url') return encodeURIComponent(value);
  if (encoding === 'json') return JSON.stringify(value).slice(1, -1);
  return value;
}

/**
 * Replaces the engine tokens of `template`. Missing values become an empty
 * string; unknown placeholders (e.g. platform macros) are left untouched.
 * Values are URL-encoded unless `encoding` says otherwise.
 */
export function resolveTokens(template: string, ctx: TokenContext, encoding: TokenEncoding = 'url'): string {
  return template.replace(TOKEN_RE, (match, name: string) => {
    let value: string | number | null | undefined;
    const simple = SIMPLE_TOKENS.get(name);
    if (simple !== undefined) value = simple(ctx);
    else if (SLOT_RE.test(name)) value = ctx.slots?.[name];
    else if (name.startsWith('data-') && name.length > 5) {
      const key = name.slice(5);
      value = ctx.fields?.[key] ?? ctx.data?.[key];
    } else return match;
    return value == null ? '' : encode(String(value), encoding);
  });
}

const RESERVED = new Set<string>(RESERVED_URL_PARAMS);

/** True for parameters owned by the link routes (`vid`, `n`, `c`, …). */
export function isReservedUrlParam(key: string): boolean {
  return RESERVED.has(key.toLowerCase());
}

/** Keys of a data passing map that are reserved and therefore rejected. */
export function reservedDataParamKeys(params: Record<string, string> | null | undefined): string[] {
  return Object.keys(params ?? {}).filter(isReservedUrlParam);
}
