import type { Breadcrumb } from '@amable/core/platform';
import { scrubMessage, scrubText } from './scrub';

/** Most recent operations of this isolate, attached to the next error event. */
const CAPACITY = 30;
const ring: Breadcrumb[] = [];

/** Records one operation. Never pass personal data; the text is scrubbed again anyway. */
export function addBreadcrumb(category: string, message: string, nowMs = Date.now()): void {
  ring.push({ at: nowMs, category: scrubText(category, 40), message: scrubMessage(message, 200) });
  if (ring.length > CAPACITY) ring.splice(0, ring.length - CAPACITY);
}

export function snapshotBreadcrumbs(): Breadcrumb[] {
  return ring.slice();
}

/** Test hook. */
export function clearBreadcrumbs(): void {
  ring.length = 0;
}
