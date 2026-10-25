import type {
  Activity,
  Appointment,
  CalendarResponse,
  Company,
  Contact,
  CreateAppointmentInput,
  CreateCompanyInput,
  CreateContactInput,
  CreateCustomFieldGroupInput,
  CreateCustomFieldInput,
  CreateCustomFieldTabInput,
  CreateImportInput,
  CreateNoteInput,
  CreateOpportunityInput,
  CreatePipelineInput,
  CreateSavedSearchInput,
  CreateStageInput,
  CreateTagCategoryInput,
  CreateTagInput,
  CreateTaskInput,
  CustomField,
  CustomFieldEntityPath,
  CustomFieldGroup,
  CustomFieldLayout,
  CustomFieldTab,
  GlobalSearchResponse,
  ImportJob,
  LeadSource,
  Note,
  Opportunity,
  Page,
  Pipeline,
  SavedSearch,
  SearchEntity,
  SearchQueryInput,
  SearchResult,
  Tag,
  TagCategory,
  TagContactsResult,
  Task,
  UpdateAppointmentInput,
  UpdateCompanyInput,
  UpdateContactInput,
  UpdateCustomFieldGroupInput,
  UpdateCustomFieldInput,
  UpdateCustomFieldTabInput,
  UpdateNoteInput,
  UpdateOpportunityInput,
  UpdatePipelineInput,
  UpdateStageInput,
  UpdateTagCategoryInput,
  UpdateTagInput,
  UpdateTaskInput,
} from '@amable/api-types/crm';
import type { ArchivedTimeline } from '@amable/api-types';
import { request, tenantRest } from '../../../lib/tenant-api';

export { TenantApiError as CrmApiError } from '../../../lib/tenant-api';

/**
 * Typed client of the CRM REST v2 surface (`/api/v2/t/{slug}`) and of the
 * tenant endpoints of the access layer (`/api/t/{slug}/me`, `/directory`).
 * Request/response types come from the shared Zod schemas in
 * `@amable/api-types/crm`, so a server contract change breaks the build here.
 */

export interface SearchFieldDescription {
  readonly field: string;
  readonly kind: SearchFieldKind;
  readonly operators: readonly string[];
  readonly sortable: boolean;
  readonly selectable: boolean;
}

export type SearchFieldKind =
  'text' | 'number' | 'date' | 'datetime_ms' | 'datetime_iso' | 'boolean' | 'enum' | 'id' | 'multi';

export interface ListParams {
  readonly limit?: number;
  readonly cursor?: string;
}

/** Saved search body as sent (the query keeps its optional defaults, e.g. sort direction). */
export type SavedSearchWrite = Omit<CreateSavedSearchInput, 'query'> & { query: SearchQueryInput };

/** Every endpoint the CRM pages use, bound to one tenant. */
export function crmClient(slug: string) {
  const { base, get, post, patch, del, me, directory } = tenantRest(slug);
  const id = (value: string) => encodeURIComponent(value);

  return {
    me,
    directory,

    contacts: {
      list: (params: ListParams & { q?: string; tag_id?: string; company_id?: string } = {}) =>
        get<Page<Contact>>('/contacts', params),
      get: (contactId: string) => get<Contact>(`/contacts/${id(contactId)}`),
      create: (input: CreateContactInput) => post<Contact>('/contacts', input),
      update: (contactId: string, input: UpdateContactInput) =>
        patch<Contact>(`/contacts/${id(contactId)}`, input),
      remove: (contactId: string) => del(`/contacts/${id(contactId)}`),
      restore: (contactId: string) => post<Contact>(`/contacts/${id(contactId)}/restore`),
      merge: (contactId: string, sourceIds: string[]) =>
        post<Contact>(`/contacts/${id(contactId)}/merge`, { source_ids: sourceIds }),
      applyTags: (contactId: string, tagIds: string[]) =>
        post<Contact>(`/contacts/${id(contactId)}/tags`, { tag_ids: tagIds }),
      removeTag: (contactId: string, tagId: string) =>
        del<Contact>(`/contacts/${id(contactId)}/tags/${id(tagId)}`),
      timeline: (contactId: string, params: ListParams = {}) =>
        get<Page<Activity>>(`/contacts/${id(contactId)}/timeline`, params),
      archivedTimeline: (contactId: string, before?: string) =>
        get<ArchivedTimeline>(`/contacts/${id(contactId)}/timeline/archive`, before === undefined ? {} : { before }),
    },
    leadSources: {
      list: () => get<{ data: LeadSource[] }>('/leadSources'),
    },
    companies: {
      list: (params: ListParams & { q?: string } = {}) => get<Page<Company>>('/companies', params),
      get: (companyId: string) => get<Company>(`/companies/${id(companyId)}`),
      create: (input: CreateCompanyInput) => post<Company>('/companies', input),
      update: (companyId: string, input: UpdateCompanyInput) =>
        patch<Company>(`/companies/${id(companyId)}`, input),
      remove: (companyId: string) => del(`/companies/${id(companyId)}`),
      restore: (companyId: string) => post<Company>(`/companies/${id(companyId)}/restore`),
      timeline: (companyId: string, params: ListParams = {}) =>
        get<Page<Activity>>(`/companies/${id(companyId)}/timeline`, params),
      archivedTimeline: (companyId: string, before?: string) =>
        get<ArchivedTimeline>(`/companies/${id(companyId)}/timeline/archive`, before === undefined ? {} : { before }),
    },
    tags: {
      list: (
        params: ListParams & { category_id?: string; name?: string; q?: string; ids?: string } = {},
      ) => get<Page<Tag>>('/tags', { limit: 200, ...params }),
      create: (input: CreateTagInput) => post<Tag>('/tags', input),
      update: (tagId: string, input: UpdateTagInput) => patch<Tag>(`/tags/${id(tagId)}`, input),
      remove: (tagId: string) => del(`/tags/${id(tagId)}`),
      restore: (tagId: string) => post<Tag>(`/tags/${id(tagId)}/restore`),
      apply: (tagId: string, contactIds: string[]) =>
        post<TagContactsResult>(`/tags/${id(tagId)}/apply`, { contact_ids: contactIds }),
      unapply: (tagId: string, contactIds: string[]) =>
        post<TagContactsResult>(`/tags/${id(tagId)}/remove`, { contact_ids: contactIds }),
    },
    tagCategories: {
      list: () => get<{ data: TagCategory[] }>('/tagCategories'),
      create: (input: CreateTagCategoryInput) => post<TagCategory>('/tagCategories', input),
      update: (categoryId: string, input: UpdateTagCategoryInput) =>
        patch<TagCategory>(`/tagCategories/${id(categoryId)}`, input),
      remove: (categoryId: string) => del(`/tagCategories/${id(categoryId)}`),
    },
    customFields: {
      list: (entity: CustomFieldEntityPath) =>
        get<{ data: CustomField[] }>(`/customFields/${entity}`),
      layout: (entity: CustomFieldEntityPath) =>
        get<CustomFieldLayout>(`/customFields/${entity}/layout`),
      create: (entity: CustomFieldEntityPath, input: CreateCustomFieldInput) =>
        post<CustomField>(`/customFields/${entity}`, input),
      update: (entity: CustomFieldEntityPath, fieldId: string, input: UpdateCustomFieldInput) =>
        patch<CustomField>(`/customFields/${entity}/${id(fieldId)}`, input),
      remove: (entity: CustomFieldEntityPath, fieldId: string) =>
        del(`/customFields/${entity}/${id(fieldId)}`),
      createTab: (entity: CustomFieldEntityPath, input: CreateCustomFieldTabInput) =>
        post<CustomFieldTab>(`/customFields/${entity}/tabs`, input),
      updateTab: (entity: CustomFieldEntityPath, tabId: string, input: UpdateCustomFieldTabInput) =>
        patch<CustomFieldTab>(`/customFields/${entity}/tabs/${id(tabId)}`, input),
      removeTab: (entity: CustomFieldEntityPath, tabId: string) =>
        del(`/customFields/${entity}/tabs/${id(tabId)}`),
      createGroup: (entity: CustomFieldEntityPath, input: CreateCustomFieldGroupInput) =>
        post<CustomFieldGroup>(`/customFields/${entity}/groups`, input),
      updateGroup: (
        entity: CustomFieldEntityPath,
        groupId: string,
        input: UpdateCustomFieldGroupInput,
      ) => patch<CustomFieldGroup>(`/customFields/${entity}/groups/${id(groupId)}`, input),
      removeGroup: (entity: CustomFieldEntityPath, groupId: string) =>
        del(`/customFields/${entity}/groups/${id(groupId)}`),
    },
    notes: {
      list: (
        params: ListParams & { contact_id?: string; company_id?: string; opportunity_id?: string },
      ) => get<Page<Note>>('/notes', params),
      get: (noteId: string) => get<Note>(`/notes/${id(noteId)}`),
      create: (input: CreateNoteInput) => post<Note>('/notes', input),
      update: (noteId: string, input: UpdateNoteInput) =>
        patch<Note>(`/notes/${id(noteId)}`, input),
      remove: (noteId: string) => del(`/notes/${id(noteId)}`),
    },
    tasks: {
      list: (
        params: ListParams & {
          status?: 'open' | 'completed';
          assigned_to?: string;
          contact_id?: string;
          opportunity_id?: string;
        } = {},
      ) => get<Page<Task>>('/tasks', params),
      create: (input: CreateTaskInput) => post<Task>('/tasks', input),
      update: (taskId: string, input: UpdateTaskInput) =>
        patch<Task>(`/tasks/${id(taskId)}`, input),
      complete: (taskId: string) => post<Task>(`/tasks/${id(taskId)}/complete`),
      reopen: (taskId: string) => post<Task>(`/tasks/${id(taskId)}/reopen`),
      remove: (taskId: string) => del(`/tasks/${id(taskId)}`),
      restore: (taskId: string) => post<Task>(`/tasks/${id(taskId)}/restore`),
    },
    appointments: {
      list: (params: ListParams & { contact_id?: string; from?: string; to?: string } = {}) =>
        get<Page<Appointment>>('/appointments', params),
      create: (input: CreateAppointmentInput) => post<Appointment>('/appointments', input),
      update: (appointmentId: string, input: UpdateAppointmentInput) =>
        patch<Appointment>(`/appointments/${id(appointmentId)}`, input),
      remove: (appointmentId: string) => del(`/appointments/${id(appointmentId)}`),
    },
    calendar: (from: string, to: string, ownerId?: string) =>
      get<CalendarResponse>('/calendar', { from, to, owner_id: ownerId }),
    pipelines: {
      list: () => get<{ data: Pipeline[] }>('/pipelines'),
      create: (input: CreatePipelineInput) => post<Pipeline>('/pipelines', input),
      update: (pipelineId: string, input: UpdatePipelineInput) =>
        patch<Pipeline>(`/pipelines/${id(pipelineId)}`, input),
      remove: (pipelineId: string) => del(`/pipelines/${id(pipelineId)}`),
      addStage: (pipelineId: string, input: CreateStageInput) =>
        post<Pipeline>(`/pipelines/${id(pipelineId)}/stages`, input),
      updateStage: (pipelineId: string, stageId: string, input: UpdateStageInput) =>
        patch<Pipeline>(`/pipelines/${id(pipelineId)}/stages/${id(stageId)}`, input),
      removeStage: (pipelineId: string, stageId: string) =>
        del<Pipeline>(`/pipelines/${id(pipelineId)}/stages/${id(stageId)}`),
    },
    opportunities: {
      list: (
        params: ListParams & {
          pipeline_id?: string;
          stage_id?: string;
          contact_id?: string;
          status?: 'open' | 'won' | 'lost';
        } = {},
      ) => get<Page<Opportunity>>('/opportunities', params),
      get: (opportunityId: string) => get<Opportunity>(`/opportunities/${id(opportunityId)}`),
      create: (input: CreateOpportunityInput) => post<Opportunity>('/opportunities', input),
      update: (opportunityId: string, input: UpdateOpportunityInput) =>
        patch<Opportunity>(`/opportunities/${id(opportunityId)}`, input),
      remove: (opportunityId: string) => del(`/opportunities/${id(opportunityId)}`),
      restore: (opportunityId: string) =>
        post<Opportunity>(`/opportunities/${id(opportunityId)}/restore`),
      timeline: (opportunityId: string, params: ListParams = {}) =>
        get<Page<Activity>>(`/opportunities/${id(opportunityId)}/timeline`, params),
      archivedTimeline: (opportunityId: string, before?: string) =>
        get<ArchivedTimeline>(`/opportunities/${id(opportunityId)}/timeline/archive`, before === undefined ? {} : { before }),
    },
    search: {
      query: (query: SearchQueryInput) => post<SearchResult>('/search', query),
      global: (q: string, limit = 20) => get<GlobalSearchResponse>('/search', { q, limit }),
      fields: (entity: SearchEntity) =>
        get<{ data: SearchFieldDescription[] }>('/search/fields', { entity }),
    },
    savedSearches: {
      list: () => get<{ data: SavedSearch[] }>('/savedSearches'),
      create: (input: SavedSearchWrite) => post<SavedSearch>('/savedSearches', input),
      update: (savedId: string, input: Partial<SavedSearchWrite>) =>
        patch<SavedSearch>(`/savedSearches/${id(savedId)}`, input),
      remove: (savedId: string) => del(`/savedSearches/${id(savedId)}`),
    },
    imports: {
      create: (input: CreateImportInput) => post<ImportJob>('/imports', input),
      get: (importId: string) => get<ImportJob>(`/imports/${id(importId)}`),
      upload: (importId: string, file: Blob) =>
        request<ImportJob>(`${base}/imports/${id(importId)}/csv`, {
          method: 'PUT',
          raw: file,
          contentType: 'text/csv',
        }),
    },
  };
}

export type CrmClient = ReturnType<typeof crmClient>;
