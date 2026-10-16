/**
 * Fleet error reporter (installation side). Captures unhandled errors of the
 * API, Durable Objects, queue consumers and cron with stack, release, module,
 * route pattern and breadcrumbs — never personal data — and sends them to the
 * sink chosen by `ERROR_REPORTING` (local logs by default). See obsidian/moduli/monitor.md.
 */
export { reportApiError, moduleFromRoute } from './api';
export { addBreadcrumb } from './breadcrumbs';
export { resolveErrorSink, type ErrorSink } from './config';
export { flushErrorOutbox, pendingErrorCount } from './outbox';
export {
  AlarmStepError,
  buildErrorEvent,
  reportAlarmFailure,
  reportError,
  withAlarmReporting,
  withErrorReporting,
  type ErrorMeta,
  type ReportOptions,
} from './reporter';
