import type {
  CreateTrackingDomainInput,
  TrackingDomain,
  TrackingDomainOptions,
} from '@amable/api-types';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api';
import { analyticsKeys, tenantBase } from './api';

/* Custom tracking domains of a site (`/api/v2/t/{slug}/analytics/tracking-domains`). */

const enc = encodeURIComponent;

export const trackingDomainKeys = {
  list: (tenant: string, siteId: string) => analyticsKeys.site(tenant, siteId, 'tracking-domains'),
};

export function trackingDomainsApi(tenant: string) {
  const base = `${tenantBase(tenant)}/tracking-domains`;
  return {
    list: (siteId: string) =>
      apiFetch<{ data: TrackingDomain[]; options: TrackingDomainOptions }>(
        `${base}?site_id=${enc(siteId)}`,
      ),
    get: (id: string) => apiFetch<TrackingDomain>(`${base}/${enc(id)}`),
    create: (input: CreateTrackingDomainInput) =>
      apiFetch<TrackingDomain>(base, { method: 'POST', body: JSON.stringify(input) }),
    check: (id: string) =>
      apiFetch<TrackingDomain>(`${base}/${enc(id)}/check`, { method: 'POST', body: '{}' }),
    remove: (id: string) =>
      apiFetch<{ id: string; deleted: true }>(`${base}/${enc(id)}`, { method: 'DELETE' }),
  };
}

export function useTrackingDomains(tenant: string, siteId: string) {
  return useQuery({
    queryKey: trackingDomainKeys.list(tenant, siteId),
    queryFn: () => trackingDomainsApi(tenant).list(siteId),
    retry: false,
  });
}
