import type { AnalyticsFilter, AnalyticsInterval, AttributionModel } from '@amable/api-types';
import { createContext, useContext, type ReactNode } from 'react';
import type { AnalyticsQuery, AnalyticsSource } from '../api';

/** What the report widgets of a page read: data source, range/filters and display settings. */
export interface ReportScope {
  readonly source: AnalyticsSource | null;
  readonly query: AnalyticsQuery;
  readonly interval: AnalyticsInterval;
  readonly model: AttributionModel;
  readonly currency: string;
  readonly timezone: string | undefined;
  /** Workspace slug (null on public share pages: no identities, no links). */
  readonly tenant: string | null;
  /** Adds an `is` filter (breakdown row click); absent = read-only rows. */
  readonly onFilter?: (filter: AnalyticsFilter) => void;
}

const ScopeContext = createContext<ReportScope | null>(null);

export function ReportScopeProvider({
  value,
  children,
}: {
  value: ReportScope;
  children: ReactNode;
}) {
  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

export function useReportScope(): ReportScope {
  const scope = useContext(ScopeContext);
  if (!scope) throw new Error('useReportScope must be used inside <ReportScopeProvider>');
  return scope;
}
