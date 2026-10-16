import type { Context } from 'hono';
import { routePath } from 'hono/route';
import type { AppEnv } from '../../middleware/context';
import { reportError } from './reporter';

const SEGMENT_SKIP = /^(?:api|v\d+|t|:slug|platform)$/;

/** `/api/v2/t/:slug/contacts/:id` → `contacts`; null for parametric / unknown roots. */
export function moduleFromRoute(route: string | null): string | null {
  if (route === null) return null;
  for (const segment of route.split('/')) {
    if (segment === '' || SEGMENT_SKIP.test(segment)) continue;
    if (segment.startsWith(':') || segment.includes('*')) return null;
    return segment.slice(0, 40);
  }
  return null;
}

/** Fire-and-forget report of an unhandled API error (called by the app error handler). */
export function reportApiError(c: Context<AppEnv>, error: unknown): void {
  try {
    let route: string | null = null;
    try {
      route = routePath(c, -1);
    } catch {
      route = null;
    }
    let waitUntil: ((promise: Promise<unknown>) => void) | undefined;
    try {
      const ctx = c.executionCtx;
      waitUntil = (promise) => ctx.waitUntil(promise);
    } catch {
      waitUntil = undefined;
    }
    const task = reportError(c.env, error, { source: 'api', route, module: moduleFromRoute(route) }, { waitUntil });
    if (waitUntil !== undefined) waitUntil(task);
    else void task;
  } catch {
    // the reporter must never affect the error response
  }
}
