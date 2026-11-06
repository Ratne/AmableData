import type { Migration } from '../types';

/**
 * The quota guard sums `platform_usage` by channel bounded to the billing
 * period on every send: without this index each check scanned the table.
 */
export const m0013PlatformUsageHourIndex: Migration = {
  id: 13,
  name: 'platform_usage_hour_index',
  statements: [`CREATE INDEX idx_platform_usage_hour ON platform_usage(channel, hour_start)`],
};
