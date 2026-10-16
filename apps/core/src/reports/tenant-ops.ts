import { commerceReportAggregate, isCommerceReportSource } from '../commerce/report-queries';
import type { CrmContext } from '../crm/context';
import { CrmError } from '../crm/errors';
import { crmReportAggregate, isCrmReportSource } from '../crm/report-queries';
import { ReportQueryError, type AggregateInput, type AggregateOutput } from './aggregate';
import * as store from './store';

function aggregate(ctx: CrmContext, input: AggregateInput): AggregateOutput {
  const { source } = input;
  try {
    if (isCrmReportSource(source)) return crmReportAggregate(ctx, { ...input, source });
    if (isCommerceReportSource(source)) return commerceReportAggregate(ctx, { ...input, source });
  } catch (error) {
    if (error instanceof ReportQueryError) throw new CrmError('validation_failed', error.message);
    throw error;
  }
  throw new CrmError('bad_request', `source ${source} is not served by the tenant database`);
}

/**
 * Report operations of the TenantDb DO (spread into `crmOps`): read-only
 * aggregates of CRM + e-commerce sources and the saved reports/dashboards.
 */
export const reportTenantOps = {
  'reports.aggregate': aggregate,
  'reports.custom.list': store.listCustomReports,
  'reports.custom.get': store.getCustomReport,
  'reports.custom.create': store.createCustomReport,
  'reports.custom.update': store.updateCustomReport,
  'reports.custom.delete': store.deleteCustomReport,
  'reports.dashboards.list': store.listDashboards,
  'reports.dashboards.get': store.getDashboard,
  'reports.dashboards.default': store.defaultDashboard,
  'reports.dashboards.create': store.createDashboard,
  'reports.dashboards.update': store.updateDashboard,
  'reports.dashboards.delete': store.deleteDashboard,
} satisfies Record<string, (ctx: CrmContext, input: never) => unknown>;
