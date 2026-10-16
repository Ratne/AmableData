import { createSandboxedLiquid } from '@amable/auth/security';
import type { Liquid, Template } from 'liquidjs';

export interface LiquidSandboxOptions {
  /** IANA zone or minutes offset used by the `date` filter; the tenant timezone. */
  readonly timezone?: string | number;
  /** Milliseconds of render time allowed per template, per recipient. */
  readonly renderLimitMs?: number;
}

/**
 * The shared sandbox from `@amable/auth/security` (no filesystem, own
 * properties only, strict filters, time/memory limits), with parse and memory
 * budgets sized for whole compiled email documents.
 */
export function createLiquid(escapeHtml: boolean, options: LiquidSandboxOptions = {}): Liquid {
  return createSandboxedLiquid({
    escapeHtml,
    parseLimit: 1_000_000,
    memoryLimit: 32 * 1024 * 1024,
    ...(options.renderLimitMs === undefined ? {} : { renderLimitMs: options.renderLimitMs }),
    ...(options.timezone === undefined ? {} : { timezone: options.timezone }),
  });
}

export interface ParsedLiquid {
  readonly engine: Liquid;
  readonly template: Template[];
}

export function parseLiquid(engine: Liquid, source: string): ParsedLiquid {
  return { engine, template: engine.parse(source) };
}

export async function renderLiquid(
  parsed: ParsedLiquid,
  context: Record<string, unknown>,
): Promise<string> {
  const output: unknown = await parsed.engine.render(parsed.template, context);
  return typeof output === 'string' ? output : String(output);
}
