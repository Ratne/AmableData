import { Liquid, type FilterImplOptions } from 'liquidjs';

type FilterHandler = Extract<FilterImplOptions, (...args: never[]) => unknown>;

/**
 * The single sandboxed LiquidJS configuration, used for every user template
 * (emails, broadcasts, automations, booking messages, snippets/dynamic content):
 * - no filesystem: include/render/layout resolve only the in-memory partials
 *   explicitly passed in (liquidjs' map FS), anything else fails;
 * - only own properties of the data are readable (no prototype walking);
 * - unknown filters are an error;
 * - output is HTML-escaped by default (`| raw` must be used deliberately);
 * - parse size, render time and memory are bounded.
 */

export interface SandboxedLiquidOptions {
  /** Named in-memory partials available to {% render %}. */
  readonly partials?: Readonly<Record<string, string>>;
  /** HTML-escape every output tag (default true); false only for plain text and subjects. */
  readonly escapeHtml?: boolean;
  /** IANA zone or minutes offset used by the `date` filter; the tenant timezone. */
  readonly timezone?: string | number;
  readonly parseLimit?: number;
  readonly renderLimitMs?: number;
  readonly memoryLimit?: number;
}

export const LIQUID_LIMITS = {
  parseLimit: 200_000,
  renderLimitMs: 1_000,
  memoryLimit: 10_000_000,
} as const;

const CALENDAR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * `date` keeps the engine timezone (the tenant's) as default, with two
 * guarantees: a blank or unknown zone argument (a contact without
 * `time_zone`) falls back to it instead of failing the whole render, and
 * calendar dates (`YYYY-MM-DD`, DATE custom fields) are never shifted to
 * the previous or next day by a zone.
 */
function installDateFilter(engine: Liquid): void {
  const builtin = engine.filters['date'];
  const handler = typeof builtin === 'function' ? builtin : builtin?.handler;
  if (handler === undefined) return;
  engine.registerFilter('date', function (this: ThisParameterType<FilterHandler>, value: unknown, format?: unknown, zone?: unknown) {
    if (typeof value === 'string' && CALENDAR_DATE_RE.test(value)) return handler.call(this, value, format, 0);
    const explicit = typeof zone === 'string' ? zone.trim() : zone;
    if (typeof explicit === 'number' || (typeof explicit === 'string' && explicit !== '' && isTimeZone(explicit))) {
      return handler.call(this, value, format, explicit);
    }
    return handler.call(this, value, format);
  });
}

export function createSandboxedLiquid(options: SandboxedLiquidOptions = {}): Liquid {
  const engine = new Liquid({
    templates: { ...options.partials },
    relativeReference: false,
    extname: '',
    ownPropertyOnly: true,
    strictFilters: true,
    strictVariables: false,
    jsTruthy: false,
    lenientIf: true,
    outputEscape: options.escapeHtml === false ? undefined : 'escape',
    cache: false,
    parseLimit: options.parseLimit ?? LIQUID_LIMITS.parseLimit,
    renderLimit: options.renderLimitMs ?? LIQUID_LIMITS.renderLimitMs,
    memoryLimit: options.memoryLimit ?? LIQUID_LIMITS.memoryLimit,
    ...(options.timezone === undefined ? {} : { timezoneOffset: options.timezone }),
  });
  installDateFilter(engine);
  return engine;
}

/** Render a template string with the sandboxed engine. */
export async function renderSandboxed(
  template: string,
  data: Record<string, unknown>,
  options?: SandboxedLiquidOptions,
): Promise<string> {
  const engine = createSandboxedLiquid(options);
  const output: unknown = await engine.parseAndRender(template, data);
  return typeof output === 'string' ? output : String(output);
}
