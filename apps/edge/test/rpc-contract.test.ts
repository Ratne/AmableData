import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AnalyticsStore } from '../src/analytics/store/index';
import { ANALYTICS_DO_RPC_METHODS } from './helpers';

/** Every .ts file under a directory (recursive). */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

const coreSrc = decodeURIComponent(new URL('../../core/src', import.meta.url).pathname);

describe('core ↔ edge AnalyticsDO RPC contract', () => {
  it('parses the RPC surface of the DO', () => {
    expect(ANALYTICS_DO_RPC_METHODS.size).toBeGreaterThan(50);
    for (const name of ['getSite', 'overview', 'breakdown', 'attribution', 'indexList', 'applyCrmFacts']) {
      expect(ANALYTICS_DO_RPC_METHODS.has(name)).toBe(true);
    }
    expect(ANALYTICS_DO_RPC_METHODS.has('constructor')).toBe(false);
  });

  it('backs every DO method with the store method of the same name', () => {
    const missing = [...ANALYTICS_DO_RPC_METHODS].filter(
      (name) => name !== 'getSchemaVersion' && typeof Reflect.get(AnalyticsStore.prototype, name) !== 'function',
    );
    expect(missing).toEqual([]);
  });

  it('only calls DO methods that exist from the core worker', () => {
    const called = new Map<string, string>();
    const chained = /\b(?:siteStub|tenantSitesStub)\([^()]*(?:\([^()]*\)[^()]*)*\)\s*\.\s*([a-zA-Z]\w*)\s*\(/g;
    for (const file of sources(coreSrc)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(chained)) {
        if (match[1] !== undefined) called.set(match[1], file);
      }
    }
    expect(called.size).toBeGreaterThan(10);
    const unknown = [...called].filter(([name]) => !ANALYTICS_DO_RPC_METHODS.has(name));
    expect(unknown).toEqual([]);
  });
});
