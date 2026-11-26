import type { SqlDb } from '../crm/db/sql';

/**
 * Counts of one workspace for the anonymous usage telemetry, read inside its
 * Durable Objects. `contacts` is exact here but never leaves the installation:
 * the ping only carries the bucket of the sum.
 */
export interface TenantUsageCounts {
  readonly contacts: number;
  readonly forms: number;
  readonly pages: number;
  readonly products: number;
  readonly bookingCalendars: number;
}

export interface EngineUsageCounts {
  readonly automations: number;
}

function count(db: SqlDb, table: string): number {
  return db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE deleted_at IS NULL`)[0]?.n ?? 0;
}

export function tenantUsageCounts(db: SqlDb): TenantUsageCounts {
  return {
    contacts: count(db, 'crm_contacts'),
    forms: count(db, 'form_forms'),
    pages: count(db, 'page_pages'),
    products: count(db, 'crm_products'),
    bookingCalendars: count(db, 'booking_calendars'),
  };
}

export function engineUsageCounts(db: SqlDb): EngineUsageCounts {
  return { automations: count(db, 'eng_automations') };
}
