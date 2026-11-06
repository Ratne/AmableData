import type {
  CreateTrackingDomainInput,
  TrackingDomain,
  TrackingDomainOptions,
} from '@amable/api-types';
import { useQuery } from '@tanstack/react-query';
import { analyticsKeys, tenantBase } from './api';
import { request } from '../../lib/tenant-api';

/* Custom tracking domains of a site (`/api/v2/t/{slug}/analytics/tracking-domains`). */

const enc = encodeURIComponent;

export const trackingDomainKeys = {
  list: (tenant: string, siteId: string) => analyticsKeys.site(tenant, siteId, 'tracking-domains'),
};

export function trackingDomainsApi(tenant: string) {
  const base = `${tenantBase(tenant)}/tracking-domains`;
  return {
    list: (siteId: string) =>
      request<{ data: TrackingDomain[]; options: TrackingDomainOptions }>(
        `${base}?site_id=${enc(siteId)}`,
      ),
    get: (id: string) => request<TrackingDomain>(`${base}/${enc(id)}`),
    create: (input: CreateTrackingDomainInput) =>
      request<TrackingDomain>(base, { method: 'POST', json: input, idempotent: false }),
    check: (id: string) =>
      request<TrackingDomain>(`${base}/${enc(id)}/check`, {
        method: 'POST',
        json: {},
        idempotent: false,
      }),
    remove: (id: string) =>
      request<{ id: string; deleted: true }>(`${base}/${enc(id)}`, { method: 'DELETE' }),
  };
}

export function useTrackingDomains(tenant: string, siteId: string) {
  return useQuery({
    queryKey: trackingDomainKeys.list(tenant, siteId),
    queryFn: () => trackingDomainsApi(tenant).list(siteId),
    retry: false,
  });
}
