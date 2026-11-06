import type { Migration } from '../types';

/**
 * The webhook cron prunes `app_events` by `created_at` every 5 minutes: without
 * this index each run scanned the whole table.
 */
export const m0012AppEventsCreatedIndex: Migration = {
  id: 12,
  name: 'app_events_created_index',
  statements: [`CREATE INDEX idx_app_events_created ON app_events(created_at)`],
};
