import type {
  ApplyTagsInput,
  Contact,
  CustomFieldEntity,
  GlobalSearchResponse,
  ListCompaniesQuery,
  ListContactsQuery,
  Page,
  Company,
  SearchQuery,
  SearchResult,
} from '@amable/api-types';
import { createCrmContext, type CrmActor, type CrmContext, type SearchMode } from './context';
import type { SqlDb } from './db/sql';
import { CrmError, type CrmErrorShape } from './errors';
import { contactIdsByMonthDay, runOnce, type OnceInput } from './automation-queries';
import { getAddressLookup, updateAddressLookup } from './address-settings';
import { getWorkspace, updateWorkspace } from '../workspace/settings';
import * as calendar from './calendar';
import * as companies from './companies';
import * as contacts from './contacts';
import { contactTabCounts, listContactTags } from './contact-tabs';
import * as customFields from './custom-fields/repo';
import * as deals from './deals';
import { analyticsCrmOps } from '../analytics/crm-ops';
import * as events from './events';
import * as idempotency from './idempotency';
import * as imports from './import/service';
import { recordEmailEvents } from './email-events';
import * as mailReads from './mail-reads';
import { mergeContacts } from './merge';
import * as notes from './notes';
import * as savedSearches from './saved-searches';
import { globalSearch, type SearchEntityKind } from './search/index-store';
import { describeFields, executeSearch } from './search/query-builder';
import * as tags from './tags';
import { commerceOps } from '../commerce/ops';
import { bookingOps } from '../booking/ops';
import { formsOps } from '../forms/ops';
import { pagesOps } from '../pages/ops';
import { reportTenantOps } from '../reports/tenant-ops';
import { appTenantOps } from '../apps/tenant-ops';
import { conversationOps } from '../conversations/ops';

function listContacts(ctx: CrmContext, input: ListContactsQuery): Page<Contact> {
  const result = executeSearch(
    ctx,
    {
      entity: 'contact',
      ...(input.q === undefined ? {} : { q: input.q }),
      columns: ['id'],
      limit: input.limit,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    },
    {
      extra: contacts.listContactsConditions(input),
      includeDeleted: input.include_deleted === 'true',
    },
  );
  const ids = result.data.map((row) => String(row['id']));
  return { data: contacts.contactsByIds(ctx, ids), next_cursor: result.next_cursor };
}

function listCompanies(ctx: CrmContext, input: ListCompaniesQuery): Page<Company> {
  const result = executeSearch(
    ctx,
    {
      entity: 'company',
      ...(input.q === undefined ? {} : { q: input.q }),
      columns: ['id'],
      sort: { field: 'name', direction: 'asc' },
      limit: input.limit,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    },
    {
      extra:
        input.owner_id === undefined
          ? []
          : [{ type: 'field', field: 'owner_id', operator: 'equals', value: input.owner_id }],
    },
  );
  return {
    data: companies.companiesByIds(
      ctx,
      result.data.map((row) => String(row['id'])),
    ),
    next_cursor: result.next_cursor,
  };
}

/**
 * Every CRM operation the TenantDb DO exposes, keyed by name. Routes call them
 * through one RPC method (`TenantDb.crm`) so the DO surface stays a single,
 * typed entry point; each call runs in one SQLite transaction.
 */
export const crmOps = {
  // contacts
  'contacts.list': listContacts,
  'contacts.get': contacts.getContact,
  'contacts.create': (ctx: CrmContext, input: Parameters<typeof contacts.createContact>[1]) =>
    contacts.createContact(ctx, input),
  'contacts.update': (ctx: CrmContext, input: Parameters<typeof contacts.updateContact>[1]) =>
    contacts.updateContact(ctx, input),
  'contacts.delete': contacts.deleteContact,
  'contacts.restore': contacts.restoreContact,
  'contacts.merge': mergeContacts,
  'contacts.applyTags': (ctx: CrmContext, input: { id: string; data: ApplyTagsInput }) => {
    contacts.getContactRow(ctx, input.id);
    tags.applyTagsToContact(ctx, input.id, input.data.tag_ids);
    return contacts.getContact(ctx, { id: input.id });
  },
  'contacts.removeTag': (ctx: CrmContext, input: { id: string; tagId: string }) => {
    contacts.getContactRow(ctx, input.id);
    tags.removeTagsFromContact(ctx, input.id, [input.tagId]);
    return contacts.getContact(ctx, { id: input.id });
  },
  'contacts.tags': listContactTags,
  'contacts.counts': contactTabCounts,
  timeline: events.timeline,
  'leadSources.list': companies.listLeadSources,
  'leadSources.create': companies.createLeadSource,
  // companies
  'companies.list': listCompanies,
  'companies.get': companies.getCompany,
  'companies.create': companies.createCompany,
  'companies.update': companies.updateCompany,
  'companies.delete': companies.deleteCompany,
  'companies.restore': companies.restoreCompany,
  // tags
  'tagCategories.list': tags.listTagCategories,
  'tagCategories.create': tags.createTagCategory,
  'tagCategories.update': tags.updateTagCategory,
  'tagCategories.delete': tags.deleteTagCategory,
  'tags.list': tags.listTags,
  'tags.get': tags.getTag,
  'tags.create': tags.createTag,
  'tags.update': tags.updateTag,
  'tags.delete': tags.deleteTag,
  'tags.restore': tags.restoreTag,
  'tags.apply': tags.applyTagToContacts,
  'tags.remove': tags.removeTagFromContacts,
  // custom fields
  'customFields.list': customFields.listCustomFields,
  'customFields.get': customFields.getCustomField,
  'customFields.create': customFields.createCustomField,
  'customFields.update': customFields.updateCustomField,
  'customFields.delete': customFields.deleteCustomField,
  'customFields.layout': customFields.customFieldLayout,
  'customFields.createTab': customFields.createCustomFieldTab,
  'customFields.updateTab': customFields.updateCustomFieldTab,
  'customFields.deleteTab': customFields.deleteCustomFieldTab,
  'customFields.createGroup': customFields.createCustomFieldGroup,
  'customFields.updateGroup': customFields.updateCustomFieldGroup,
  'customFields.deleteGroup': customFields.deleteCustomFieldGroup,
  // notes
  'notes.list': notes.listNotes,
  'notes.get': notes.getNote,
  'notes.create': notes.createNote,
  'notes.update': notes.updateNote,
  'notes.delete': notes.deleteNote,
  // tasks & appointments
  'tasks.list': calendar.listTasks,
  'tasks.get': calendar.getTask,
  'tasks.create': calendar.createTask,
  'tasks.update': calendar.updateTask,
  'tasks.complete': calendar.completeTask,
  'tasks.reopen': calendar.reopenTask,
  'tasks.delete': calendar.deleteTask,
  'appointments.list': calendar.listAppointments,
  'appointments.get': calendar.getAppointment,
  'appointments.create': calendar.createAppointment,
  'appointments.update': calendar.updateAppointment,
  'appointments.delete': calendar.deleteAppointment,
  calendar: calendar.calendar,
  // pipelines & opportunities
  'pipelines.list': deals.listPipelines,
  'pipelines.get': deals.getPipeline,
  'pipelines.create': deals.createPipeline,
  'pipelines.update': deals.updatePipeline,
  'pipelines.delete': deals.deletePipeline,
  'pipelines.createStage': deals.createStage,
  'pipelines.updateStage': deals.updateStage,
  'pipelines.deleteStage': deals.deleteStage,
  'opportunities.list': deals.listOpportunities,
  'opportunities.get': deals.getOpportunity,
  'opportunities.create': deals.createOpportunity,
  'opportunities.update': deals.updateOpportunity,
  'opportunities.delete': deals.deleteOpportunity,
  // search
  'search.query': (ctx: CrmContext, input: SearchQuery): SearchResult => executeSearch(ctx, input),
  'search.global': (
    ctx: CrmContext,
    input: { q: string; types: SearchEntityKind[]; limit: number },
  ): GlobalSearchResponse => globalSearch(ctx, input),
  'search.fields': describeFields,
  'savedSearches.list': savedSearches.listSavedSearches,
  'savedSearches.get': savedSearches.getSavedSearch,
  'savedSearches.create': savedSearches.createSavedSearch,
  'savedSearches.update': savedSearches.updateSavedSearch,
  'savedSearches.delete': savedSearches.deleteSavedSearch,
  'savedSearches.execute': savedSearches.executeSavedSearch,
  'savedSearches.memberIds': savedSearches.savedSearchMemberIds,
  // imports
  'imports.create': imports.createImport,
  'imports.get': imports.getImport,
  'imports.rows': imports.importRows,
  'imports.finish': imports.finishImport,
  // outbox (automation engine) & idempotency (REST layer)
  'events.pending': events.pendingEvents,
  'events.ack': events.ackEvents,
  'automation.contactIdsByMonthDay': contactIdsByMonthDay,
  'automation.once': (ctx: CrmContext, input: OnceInput): { replayed: boolean; value: unknown } =>
    runOnce(ctx, input, (op, opInput) => runNestedCrmOp(ctx, op, opInput)),
  'idempotency.begin': idempotency.idempotencyBegin,
  'idempotency.complete': idempotency.idempotencyComplete,
  'idempotency.abort': idempotency.idempotencyAbort,
  'addressLookup.settings.get': getAddressLookup,
  'addressLookup.settings.update': updateAddressLookup,
  'workspace.settings.get': getWorkspace,
  'workspace.settings.update': updateWorkspace,
  // e-commerce (apps/core/src/commerce)
  ...commerceOps,
  // web analytics sync, read-only (apps/core/src/analytics)
  ...analyticsCrmOps,
  // forms, calendars & bookings, landing pages (apps/core/src/{forms,booking,pages})
  ...formsOps,
  ...bookingOps,
  ...pagesOps,
  // report engine: read-only aggregates + saved reports/dashboards (apps/core/src/reports)
  ...reportTenantOps,
  // email module (read-only, apps/core/src/email)
  'mail.segmentMemberIds': mailReads.segmentMemberIds,
  'mail.recipientFacts': mailReads.recipientFacts,
  'mail.contactsForSend': mailReads.contactsForSend,
  // email events bridged into the outbox and the timeline (apps/core/src/email/bridge.ts)
  'mail.recordEvents': recordEmailEvents,
  // marketplace apps: per-app data, record values, owned fields, timeline, erasure (apps/core/src/apps)
  ...appTenantOps,
  // shared inbox (apps/core/src/conversations)
  ...conversationOps,
} satisfies Record<string, (ctx: CrmContext, input: never) => unknown>;

export type CrmOps = typeof crmOps;
export type CrmOpName = keyof CrmOps;
export type CrmOpInput<K extends CrmOpName> = Parameters<CrmOps[K]>[1];
export type CrmOpOutput<K extends CrmOpName> = ReturnType<CrmOps[K]>;

export type CrmResult<T> = { ok: true; value: T } | { ok: false; error: CrmErrorShape };

export function isCrmOp(op: string): op is CrmOpName {
  return Object.hasOwn(crmOps, op);
}

/** Runs an operation inside the current one (same context and transaction). */
function runNestedCrmOp(ctx: CrmContext, op: string, input: unknown): unknown {
  if (!isCrmOp(op) || op === 'automation.once') {
    throw new CrmError('bad_request', `unknown CRM operation ${op}`);
  }
  return (crmOps[op] as (ctx: CrmContext, input: unknown) => unknown)(ctx, input);
}

/**
 * Runs one operation atomically. Domain errors become `{ ok: false }` results
 * (structured clone across RPC would lose the error class); anything else is
 * rethrown and surfaces as a 500.
 */
export function runCrmOp(
  env: { db: SqlDb; searchMode: SearchMode; now?: () => number },
  actor: CrmActor,
  op: string,
  input: unknown,
): CrmResult<unknown> {
  if (!isCrmOp(op)) {
    return {
      ok: false,
      error: new CrmError('bad_request', `unknown CRM operation ${op}`).toShape(),
    };
  }
  const ctx = createCrmContext(
    env.db,
    actor,
    env.searchMode,
    env.now === undefined ? {} : { now: env.now },
  );
  const fn = crmOps[op] as (ctx: CrmContext, input: unknown) => unknown;
  try {
    return { ok: true, value: env.db.transaction(() => fn(ctx, input)) };
  } catch (error) {
    if (error instanceof CrmError) return { ok: false, error: error.toShape() };
    throw error;
  }
}

export type { CustomFieldEntity };
