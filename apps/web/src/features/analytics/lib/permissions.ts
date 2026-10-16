import type { Permission } from '@amable/core';
import { useCallback, useMemo } from 'react';
import { useMe } from '../../../lib/api';

export interface AnalyticsPermissions {
  readonly ready: boolean;
  readonly can: (permission: Permission) => boolean;
  readonly read: boolean;
  readonly configure: boolean;
  /** Funnels and segments: `analytics:configure` or `reports:create`. */
  readonly editReports: boolean;
  readonly journey: boolean;
}

/** Permissions of the active membership; actions stay hidden until they are known. */
export function useAnalyticsPermissions(tenant: string): AnalyticsPermissions {
  const me = useMe();
  const granted = useMemo(() => {
    const membership = me.data?.memberships.find((candidate) => candidate.slug === tenant);
    return new Set<Permission>(membership?.permissions ?? []);
  }, [me.data, tenant]);
  const can = useCallback((permission: Permission) => granted.has(permission), [granted]);
  return {
    ready: me.data !== undefined,
    can,
    read: can('analytics:read'),
    configure: can('analytics:configure'),
    editReports: can('analytics:configure') || can('reports:create'),
    journey: can('analytics:journey_read'),
  };
}
