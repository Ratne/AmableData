import { MAX_FUNNEL_ACTION, type TrafficSource } from '@amable/api-types';
import { isReservedUrlParam, resolveTokens, type TokenContext } from './tokens';

/** Fields of a traffic source used to build links. */
export type LinkSource = Pick<TrafficSource, 'id' | 'reserved_fields' | 'fields'>;

function trimBase(base: string): string {
  return base.replace(/\/+$/, '');
}

/**
 * `url_param=source_token` pairs of the fields marked `append` with a source
 * token: campaign, external, then custom fields by slot. Source tokens are
 * platform macros and are kept verbatim.
 */
export function sourceFieldPairs(source: LinkSource): string[] {
  const slotNumber = (slot: string) => Number(slot.slice(1));
  const fields = [
    source.reserved_fields.campaign,
    source.reserved_fields.external,
    ...[...source.fields].sort((a, b) => slotNumber(a.slot) - slotNumber(b.slot)),
  ];
  return fields.filter((f) => f.append && f.source_token !== '').map((f) => `${f.url_param}=${f.source_token}`);
}

export interface EntranceLinkOptions {
  /** Entry node when it is not the traffic node. */
  nodeId?: string;
  /** Page of the entry page group. */
  pageId?: string;
  /** Entrance cost (`0.004`, `cpm_12.34` or a platform macro). */
  cost?: string | null;
}

/** Tracking link: `{base}/go/{funnelId}-{sourceId}[/{nodeId}[/{pageId}]]?{fields}[&c=…]`. */
export function buildEntranceUrl(
  base: string,
  funnelId: string,
  source: LinkSource,
  opts: EntranceLinkOptions = {},
): string {
  let path = `${trimBase(base)}/go/${encodeURIComponent(funnelId)}-${encodeURIComponent(source.id)}`;
  if (opts.nodeId) {
    path += `/${encodeURIComponent(opts.nodeId)}`;
    if (opts.pageId) path += `/${encodeURIComponent(opts.pageId)}`;
  }
  const pairs = sourceFieldPairs(source);
  if (opts.cost) pairs.push(`c=${opts.cost}`);
  return pairs.length > 0 ? `${path}?${pairs.join('&')}` : path;
}

export interface ActionLinkDefaults {
  funnelId: string;
  nodeId: string;
}

/** Action link `/a/N`, or `/go/{funnelId}/{nodeId}/a/N` carrying the default origin. */
export function buildActionUrl(base: string, action: number, defaults?: ActionLinkDefaults): string {
  if (!Number.isInteger(action) || action < 1 || action > MAX_FUNNEL_ACTION) {
    throw new RangeError(`action must be an integer between 1 and ${MAX_FUNNEL_ACTION}`);
  }
  const root = trimBase(base);
  if (defaults === undefined) return `${root}/a/${action}`;
  return `${root}/go/${encodeURIComponent(defaults.funnelId)}/${encodeURIComponent(defaults.nodeId)}/a/${action}`;
}

export interface DirectSuffixOptions {
  nodeId: string;
  pageId?: string;
  /** Omit `p` (clashes with the WordPress post id parameter). */
  wordpress?: boolean;
}

/** Query suffix for pages linked directly from an ad: `f, ts, n[, p]` + source fields. */
export function buildDirectSuffix(funnelId: string, source: LinkSource, opts: DirectSuffixOptions): string {
  const pairs = [
    `f=${encodeURIComponent(funnelId)}`,
    `ts=${encodeURIComponent(source.id)}`,
    `n=${encodeURIComponent(opts.nodeId)}`,
  ];
  if (opts.pageId && !opts.wordpress) pairs.push(`p=${encodeURIComponent(opts.pageId)}`);
  return [...pairs, ...sourceFieldPairs(source)].join('&');
}

/** Appends a query suffix to a page URL. */
export function buildDirectUrl(pageUrl: string, suffix: string): string {
  if (suffix === '') return pageUrl;
  const hash = pageUrl.indexOf('#');
  const head = hash >= 0 ? pageUrl.slice(0, hash) : pageUrl;
  const fragment = hash >= 0 ? pageUrl.slice(hash) : '';
  const sep = !head.includes('?') ? '?' : head.endsWith('?') || head.endsWith('&') ? '' : '&';
  return `${head}${sep}${suffix}${fragment}`;
}

export interface MergeExtra {
  /** Context for `{token}` placeholders in parameter values. */
  tokens?: TokenContext;
  /** Visitor id set as `vid`, overriding any value of the base URL. */
  vid?: string | null;
  /** Lowest-priority parameters after the base URL (e.g. the visit data buffer). */
  params?: Record<string, string> | null;
}

function decodeKey(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return raw;
  }
}

/**
 * Builds a destination URL by layering data passing parameters on the base
 * URL: base URL → `extra.params` → node level → page level, the last layer
 * winning per key without duplicates. Reserved keys are dropped from every
 * layer except the base URL; `vid` is set last.
 */
export function mergeDestinationUrl(
  baseUrl: string,
  nodeParams?: Record<string, string> | null,
  pageParams?: Record<string, string> | null,
  extra: MergeExtra = {},
): string {
  if (baseUrl === '') return '';
  const hash = baseUrl.indexOf('#');
  const fragment = hash >= 0 ? baseUrl.slice(hash) : '';
  const rest = hash >= 0 ? baseUrl.slice(0, hash) : baseUrl;
  const q = rest.indexOf('?');
  const path = q >= 0 ? rest.slice(0, q) : rest;

  const pairs = new Map<string, string>();
  for (const part of (q >= 0 ? rest.slice(q + 1) : '').split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    pairs.set(decodeKey(eq >= 0 ? part.slice(0, eq) : part), part);
  }
  const put = (layer: Record<string, string> | null | undefined) => {
    for (const [key, template] of Object.entries(layer ?? {})) {
      if (isReservedUrlParam(key)) continue;
      const value = extra.tokens ? resolveTokens(template, extra.tokens, 'raw') : template;
      pairs.set(key, `${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
  };
  put(extra.params);
  put(nodeParams);
  put(pageParams);
  if (extra.vid) pairs.set('vid', `vid=${encodeURIComponent(extra.vid)}`);

  const query = [...pairs.values()].join('&');
  return `${path}${query ? `?${query}` : ''}${fragment}`;
}
