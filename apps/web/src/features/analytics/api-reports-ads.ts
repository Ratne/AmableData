import type {
  AdPlatform,
  CohortReport,
  JourneyReport,
  LtvReport,
  PerformanceReport,
  TrackingQuality,
} from '@amable/api-types';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ApiError, apiFetch } from '../../lib/api';
import { analyticsKeys, tenantBase } from './api';
import {
  performanceQueryString,
  queryString,
  type PerformanceRequest,
  type ReportRange,
} from './reports-ads/model';

/*
 * Client of the ad attribution reports (`/api/v2/t/{slug}/analytics/ads-reports/*`):
 * performance, LTV, cohorts, journeys and tracking quality.
 */

export interface LtvRequest extends ReportRange {
  readonly group_by: 'source' | 'campaign' | 'platform';
  readonly model: 'first_click' | 'last_click';
}

export interface CohortRequest extends ReportRange {
  readonly granularity: 'week' | 'month';
  readonly platform?: AdPlatform;
  readonly traffic_source_id?: string;
}

export interface JourneyRequest extends ReportRange {
  readonly step: 'source' | 'campaign' | 'node';
  readonly converted_only: boolean;
  readonly limit?: number;
}

const base = (tenant: string) => `${tenantBase(tenant)}/ads-reports`;

export const adsReportsApi = {
  performance: (tenant: string, request: PerformanceRequest) =>
    apiFetch<PerformanceReport>(`${base(tenant)}/performance?${performanceQueryString(request)}`),
  ltv: (tenant: string, siteId: string, request: LtvRequest) =>
    apiFetch<LtvReport>(`${base(tenant)}/ltv?${queryString({ site_id: siteId, ...request })}`),
  cohorts: (tenant: string, siteId: string, request: CohortRequest) =>
    apiFetch<CohortReport>(
      `${base(tenant)}/cohorts?${queryString({ site_id: siteId, ...request })}`,
    ),
  journeys: (tenant: string, siteId: string, request: JourneyRequest) =>
    apiFetch<JourneyReport>(
      `${base(tenant)}/journeys?${queryString({ site_id: siteId, ...request })}`,
    ),
  trackingQuality: (tenant: string, siteId: string, range: ReportRange) =>
    apiFetch<TrackingQuality>(
      `${base(tenant)}/tracking-quality?${queryString({ site_id: siteId, ...range })}`,
    ),
};

const retry = (count: number, error: unknown) =>
  !(error instanceof ApiError && error.status < 500) && count < 2;

function useAdsReport<T>(
  tenant: string,
  siteId: string | null,
  name: string,
  request: unknown,
  fetcher: (siteId: string) => Promise<T>,
  enabled = true,
) {
  return useQuery({
    queryKey: analyticsKeys.site(tenant, siteId ?? '', `ads-reports:${name}`, request),
    queryFn: () => fetcher(siteId!),
    enabled: siteId !== null && enabled,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    retry,
  });
}

export function usePerformanceReport(
  tenant: string,
  request: PerformanceRequest | null,
  enabled = true,
) {
  return useAdsReport(
    tenant,
    request?.site_id ?? null,
    'performance',
    request,
    () => adsReportsApi.performance(tenant, request!),
    enabled,
  );
}

export const useLtvReport = (tenant: string, siteId: string | null, request: LtvRequest) =>
  useAdsReport(tenant, siteId, 'ltv', request, (id) => adsReportsApi.ltv(tenant, id, request));

export const useCohortReport = (tenant: string, siteId: string | null, request: CohortRequest) =>
  useAdsReport(tenant, siteId, 'cohorts', request, (id) =>
    adsReportsApi.cohorts(tenant, id, request),
  );

export const useJourneyReport = (tenant: string, siteId: string | null, request: JourneyRequest) =>
  useAdsReport(tenant, siteId, 'journeys', request, (id) =>
    adsReportsApi.journeys(tenant, id, request),
  );

export const useTrackingQuality = (tenant: string, siteId: string | null, range: ReportRange) =>
  useAdsReport(tenant, siteId, 'tracking-quality', range, (id) =>
    adsReportsApi.trackingQuality(tenant, id, range),
  );
