import type { ReportDefinition, ReportOverrides } from '@amable/api-types/reports';
import { toast } from '@amable/ui';
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import { useMemo } from 'react';
import { useI18n } from '../../../i18n';
import { errorMessage, usePermissions, useTenantMe, useTenantSlug } from '../../crm/api/hooks';
import { canCreateReports, canExportReports, canReadReports } from '../lib/export';
import { reportClient, type ReportClient } from './client';

export const reportKeys = {
  root: (slug: string) => ['reports', slug] as const,
  catalog: (slug: string) => ['reports', slug, 'catalog'] as const,
  entry: (slug: string, id: string) => ['reports', slug, 'entry', id] as const,
  run: (slug: string, id: string, overrides: ReportOverrides | undefined) =>
    ['reports', slug, 'run', id, overrides ?? null] as const,
  adHoc: (slug: string, definition: ReportDefinition | null) =>
    ['reports', slug, 'adhoc', definition] as const,
  custom: (slug: string, id: string) => ['reports', slug, 'custom', id] as const,
  dashboards: (slug: string) => ['reports', slug, 'dashboards'] as const,
  dashboard: (slug: string, id: string) => ['reports', slug, 'dashboards', id] as const,
  home: (slug: string) => ['reports', slug, 'dashboards', 'home'] as const,
};

export function useReportApi(): { slug: string; api: ReportClient } {
  const slug = useTenantSlug();
  const api = useMemo(() => reportClient(slug), [slug]);
  return { slug, api };
}

export function useReportPermissions() {
  const { can, ready } = usePermissions();
  const me = useTenantMe();
  return {
    ready,
    canRead: canReadReports(can),
    canCreate: canCreateReports(can),
    canExport: canExportReports(can),
    /** Making a dashboard the tenant home is reserved to `settings:manage` (owner/admin). */
    canManageAll: can('settings:manage'),
    can,
    role: me.data?.role ?? null,
  };
}

export function useReportCatalog() {
  const { slug, api } = useReportApi();
  return useQuery({ queryKey: reportKeys.catalog(slug), queryFn: () => api.catalog() });
}

export function useReportEntry(reportId: string) {
  const { slug, api } = useReportApi();
  return useQuery({
    queryKey: reportKeys.entry(slug, reportId),
    queryFn: () => api.get(reportId),
    enabled: reportId !== '',
    retry: false,
  });
}

export function useReportRun(reportId: string, overrides?: ReportOverrides, enabled = true) {
  const { slug, api } = useReportApi();
  return useQuery({
    queryKey: reportKeys.run(slug, reportId, overrides),
    queryFn: () => api.run(reportId, overrides),
    placeholderData: keepPreviousData,
    enabled,
    retry: false,
  });
}

export function useAdHocRun(definition: ReportDefinition | null) {
  const { slug, api } = useReportApi();
  return useQuery({
    queryKey: reportKeys.adHoc(slug, definition),
    queryFn: () => api.runAdHoc(definition as ReportDefinition),
    enabled: definition !== null,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useCustomReport(reportId: string | null) {
  const { slug, api } = useReportApi();
  return useQuery({
    queryKey: reportKeys.custom(slug, reportId ?? ''),
    queryFn: () => api.customReport(reportId ?? ''),
    enabled: reportId !== null,
  });
}

export function useDashboards() {
  const { slug, api } = useReportApi();
  return useQuery({
    queryKey: reportKeys.dashboards(slug),
    queryFn: async () => (await api.dashboards()).data,
  });
}

export function useDashboard(dashboardId: string) {
  const { slug, api } = useReportApi();
  return useQuery({
    queryKey: reportKeys.dashboard(slug, dashboardId),
    queryFn: () => api.dashboard(dashboardId),
  });
}

export function useHomeDashboard(enabled: boolean) {
  const { slug, api } = useReportApi();
  return useQuery({
    queryKey: reportKeys.home(slug),
    queryFn: () => api.homeDashboard(),
    enabled,
    retry: false,
  });
}

export interface ReportMutationOptions<TInput, TResult> {
  readonly mutationFn: (input: TInput) => Promise<TResult>;
  readonly invalidate?: readonly QueryKey[];
  readonly success?: string | ((result: TResult) => string);
  readonly onSuccess?: (result: TResult, input: TInput) => void;
  /** Return true to silence the default error toast. */
  readonly onError?: (error: unknown) => boolean | void;
}

/** `useMutation` with cache invalidation and toasts. */
export function useReportMutation<TInput, TResult>(
  options: ReportMutationOptions<TInput, TResult>,
) {
  const { slug } = useReportApi();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: options.mutationFn,
    onSuccess: async (result, input) => {
      const keys = options.invalidate ?? [reportKeys.root(slug)];
      await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
      if (options.success !== undefined) {
        toast.success(
          typeof options.success === 'function' ? options.success(result) : options.success,
        );
      }
      options.onSuccess?.(result, input);
    },
    onError: (error) => {
      if (options.onError?.(error) === true) return;
      toast.error(errorMessage(t, error));
    },
  });
}
