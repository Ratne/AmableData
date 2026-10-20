import type {
  CreateCustomReportInput,
  CreateDashboardInput,
  CustomReport,
  Dashboard,
  ReportCatalogEntry,
  ReportDefinition,
  ReportOverrides,
  ReportResult,
  ReportSource,
  ReportSourceSpec,
  UpdateCustomReportInput,
  UpdateDashboardInput,
} from '@amable/api-types/reports';
import { request } from '../../../lib/tenant-api';

/**
 * Typed client of the report REST v2 surface (`/api/v2/t/{slug}/reports…`,
 * `customReports`, `dashboards`). Errors are `CrmApiError`.
 */

export interface ReportCatalog {
  readonly data: ReportCatalogEntry[];
  /** Sources the caller can read (report builder choices). */
  readonly sources: Partial<Record<ReportSource, ReportSourceSpec>>;
}

export function reportClient(slug: string) {
  const base = `/api/v2/t/${encodeURIComponent(slug)}`;
  const id = (value: string) => encodeURIComponent(value);

  return {
    catalog: () => request<ReportCatalog>(`${base}/reports`),
    get: (reportId: string) => request<ReportCatalogEntry>(`${base}/reports/${id(reportId)}`),
    run: (reportId: string, overrides?: ReportOverrides) =>
      request<ReportResult>(`${base}/reports/${id(reportId)}/run`, {
        method: 'POST',
        json: overrides === undefined ? {} : { overrides },
      }),
    runAdHoc: (definition: ReportDefinition) =>
      request<ReportResult>(`${base}/reports/run`, { method: 'POST', json: { definition } }),

    customReport: (reportId: string) =>
      request<CustomReport>(`${base}/customReports/${id(reportId)}`),
    createCustomReport: (input: CreateCustomReportInput) =>
      request<CustomReport>(`${base}/customReports`, { method: 'POST', json: input }),
    updateCustomReport: (reportId: string, input: UpdateCustomReportInput) =>
      request<CustomReport>(`${base}/customReports/${id(reportId)}`, {
        method: 'PATCH',
        json: input,
      }),
    deleteCustomReport: (reportId: string) =>
      request<{ id: string; deleted: true }>(`${base}/customReports/${id(reportId)}`, {
        method: 'DELETE',
      }),

    dashboards: () => request<{ data: Dashboard[] }>(`${base}/dashboards`),
    homeDashboard: () => request<Dashboard>(`${base}/dashboards/home`),
    dashboard: (dashboardId: string) => request<Dashboard>(`${base}/dashboards/${id(dashboardId)}`),
    createDashboard: (input: CreateDashboardInput) =>
      request<Dashboard>(`${base}/dashboards`, { method: 'POST', json: input }),
    updateDashboard: (dashboardId: string, input: UpdateDashboardInput) =>
      request<Dashboard>(`${base}/dashboards/${id(dashboardId)}`, { method: 'PATCH', json: input }),
    deleteDashboard: (dashboardId: string) =>
      request<{ id: string; deleted: true }>(`${base}/dashboards/${id(dashboardId)}`, {
        method: 'DELETE',
      }),
  };
}

export type ReportClient = ReturnType<typeof reportClient>;
