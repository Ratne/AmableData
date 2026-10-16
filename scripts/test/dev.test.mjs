import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEV_EDGE_HEADER as CORE_HEADER } from '../../apps/core/src/public/dev-edge.ts';
import { DEV_EDGE_HEADER, devCoreConfig, devEdgeConfig, parseJsonc } from '../dev.mjs';

const config = (app) => parseJsonc(readFileSync(new URL(`../../apps/${app}/wrangler.jsonc`, import.meta.url), 'utf8'));
const origins = { core: 'http://127.0.0.1:9000', edge: 'http://127.0.0.1:9001' };

describe('scripts/dev.mjs', () => {
  it('parses JSONC with comments, trailing commas and slashes inside strings', () => {
    expect(parseJsonc('{\n  // c\n  "a": "http://x/*y*/", /* b */\n  "b": [1, 2,],\n}')).toEqual({
      a: 'http://x/*y*/',
      b: [1, 2],
    });
  });

  it('binds the edge fetch into the core dev config and sets both local origins', () => {
    const core = devCoreConfig(config('core'), origins);
    expect(core.services).toContainEqual({ binding: 'EDGE_DEV', service: 'amable-edge' });
    expect(core.vars.EDGE_ORIGIN).toBe(origins.edge);
    expect(core.vars.ENVIRONMENT).toBe('dev');
    expect(core.durable_objects.bindings).toContainEqual(
      expect.objectContaining({ name: 'ANALYTICS', class_name: 'AnalyticsDO', script_name: 'amable-edge' }),
    );
    expect(devCoreConfig(core, origins).services.filter((s) => s.binding === 'EDGE_DEV')).toHaveLength(1);
    const edge = devEdgeConfig(config('edge'), origins);
    expect(edge.name).toBe('amable-edge');
    expect(edge.vars.CORE_ORIGIN).toBe(origins.core);
  });

  it('uses the same proxy header as the core worker', () => {
    expect(DEV_EDGE_HEADER).toBe(CORE_HEADER);
  });
});
