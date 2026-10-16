import type { Permission } from '@amable/core';
import type { ReportOverrides } from '@amable/api-types/reports';

/** CSV export needs `reports:export` on top of reading the report (enforced again by the server). */
export function canExportReports(can: (permission: Permission) => boolean): boolean {
  return can('reports:export');
}

/** Reading reports: `reports:read`, or `reports:sales_read` for the sales role. */
export function canReadReports(can: (permission: Permission) => boolean): boolean {
  return can('reports:read') || can('reports:sales_read');
}

export function canCreateReports(can: (permission: Permission) => boolean): boolean {
  return can('reports:create');
}

/** Same-origin download URL of `GET /reports/{id}/export.csv` with the toolbar overrides. */
export function exportCsvUrl(slug: string, reportId: string, overrides: ReportOverrides): string {
  const base = `/api/v2/t/${encodeURIComponent(slug)}/reports/${encodeURIComponent(reportId)}/export.csv`;
  const clean = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  );
  if (Object.keys(clean).length === 0) return base;
  return `${base}?${new URLSearchParams({ overrides: JSON.stringify(clean) }).toString()}`;
}
