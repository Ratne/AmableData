import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  AD_CONNECTION_STATUSES,
  AD_PLATFORMS,
  ATTRIBUTION_MODELS_V2,
  CONDITION_ATTRIBUTES,
  CONDITION_OPERATORS,
  COST_TYPES,
  FUNNEL_GRAPH_ERROR_CODES,
  FUNNEL_NODE_KINDS,
  OUTBOUND_STATUSES,
  PAGE_TYPES,
  PERFORMANCE_GROUP_BY,
  REPORT_BASIS,
  ROTATOR_STICKINESS,
  TOUCH_KINDS,
  TRACKING_DOMAIN_STATUSES,
} from '@amable/api-types';
import { describe, expect, it } from 'vitest';
import { analyticsEn } from '../../../packages/i18n/src/catalogs/analytics-en';
import { analyticsIt } from '../../../packages/i18n/src/catalogs/analytics-it';

const en: Record<string, string> = analyticsEn;
const it_: Record<string, string> = analyticsIt;
const featureDir = decodeURIComponent(new URL('../src/features/analytics', import.meta.url).pathname);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Static `analytics.*` keys of the analytics UI: every quoted literal (t() calls, label maps). */
function staticKeys(): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of sources(featureDir)) {
    for (const m of readFileSync(file, 'utf8').matchAll(/['"`](analytics\.[A-Za-z0-9_.-]*[A-Za-z0-9_])['"`]/g)) {
      if (m[1] !== undefined && !out.has(m[1])) out.set(m[1], file.slice(featureDir.length + 1));
    }
  }
  return out;
}

const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort();

describe('analytics catalogs', () => {
  it('have the same keys in English and Italian', () => {
    expect(Object.keys(it_).filter((k) => !(k in en))).toEqual([]);
    expect(Object.keys(en).filter((k) => !(k in it_))).toEqual([]);
  });

  it('keep the placeholders of every message', () => {
    const mismatched = Object.keys(en).filter((k) => placeholders(en[k] ?? '').join() !== placeholders(it_[k] ?? '').join());
    expect(mismatched).toEqual([]);
  });

  it('translate every sentence (identical texts only for names and acronyms)', () => {
    const allowed = new Set(['analytics.integrations.search_console.name', 'analytics.performance.vsPrevious']);
    const copies = Object.keys(en).filter(
      (k) => !allowed.has(k) && en[k] === it_[k] && (en[k] ?? '').trim().split(/\s+/).length >= 3,
    );
    expect(copies).toEqual([]);
  });

  it('cover every static key used by the analytics UI', () => {
    const keys = staticKeys();
    expect(keys.size).toBeGreaterThan(500);
    expect([...keys].filter(([k]) => !(k in en)).map(([k, file]) => `${k} (${file})`)).toEqual([]);
  });

  it('cover the labels built from the contract enums', () => {
    const expected = [
      ...FUNNEL_NODE_KINDS.map((v) => `analytics.funnelBuilder.kind.${v}`),
      ...FUNNEL_GRAPH_ERROR_CODES.map((v) => `analytics.funnelBuilder.error.${v}`),
      ...CONDITION_ATTRIBUTES.map((v) => `analytics.funnelBuilder.panel.attr.${v}`),
      ...CONDITION_OPERATORS.map((v) => `analytics.funnelBuilder.panel.op.${v}`),
      ...ROTATOR_STICKINESS.map((v) => `analytics.funnelBuilder.panel.stickiness.${v}`),
      ...PAGE_TYPES.map((v) => `analytics.funnelBuilder.panel.pageType.${v}`),
      ...ATTRIBUTION_MODELS_V2.flatMap((v) => [`analytics.performance.model.${v}`, `analytics.performance.modelHint.${v}`]),
      ...PERFORMANCE_GROUP_BY.map((v) => `analytics.performance.group.${v}`),
      ...REPORT_BASIS.flatMap((v) => [`analytics.performance.basis.${v}`, `analytics.performance.basisHint.${v}`]),
      ...AD_PLATFORMS.flatMap((v) => [`analytics.performance.platform.${v}`, `analytics.ads.connections.platform.${v}`]),
      ...AD_CONNECTION_STATUSES.map((v) => `analytics.ads.connections.status.${v}`),
      ...OUTBOUND_STATUSES.map((v) => `analytics.ads.outbound.status.${v}`),
      ...TRACKING_DOMAIN_STATUSES.map((v) => `analytics.domains.status.${v}`),
      ...COST_TYPES.map((v) => `analytics.sources.costType.${v}`),
      ...TOUCH_KINDS.map((v) => `analytics.journeys.contact.kind.${v}`),
    ];
    expect(expected.filter((k) => !(k in en))).toEqual([]);
  });
});
