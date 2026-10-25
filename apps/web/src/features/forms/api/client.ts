import type {
  ArchivedMonths,
  ArchivedSubmissions,
  ConnectionTestResult,
  ConnectorInfo,
  CreateConnectionInput,
  CustomField,
  Form,
  FormConnection,
  FormConnectionWithSecret,
  FormEmbed,
  FormSubmission,
  FormSummary,
  LeadSource,
  ListFormsQuery,
  Page,
  SubmissionStatus,
  UpdateConnectionInput,
  UpdateFormInput,
} from '@amable/api-types';
import type { FormDefinition } from '@amable/forms';
import { type Deleted, tenantRest } from '../../../lib/tenant-api';

export { TenantApiError as FormsApiError } from '../../../lib/tenant-api';

/**
 * Typed client of the forms REST v2 surface (`/api/v2/t/{slug}`) plus the CRM
 * lookups the builder needs (contact custom fields, tags, lead sources, members).
 */

/** A form whose definition is typed with the @amable/forms schema (the API returns it normalized). */
export type TypedForm = Omit<Form, 'definition'> & { definition: FormDefinition };

export function formsClient(slug: string) {
  const { get, post, patch, del, me, directory } = tenantRest(slug, { idempotent: false });
  const id = encodeURIComponent;
  const form = (formId: string) => `/forms/${id(formId)}`;

  return {
    me,
    directory,
    forms: {
      list: (params: Partial<ListFormsQuery> = {}) =>
        get<Page<FormSummary>>('/forms', { limit: 200, ...params }),
      get: (formId: string) => get<TypedForm>(form(formId)),
      create: (input: { name: string; definition?: FormDefinition }) =>
        post<TypedForm>('/forms', input),
      update: (
        formId: string,
        input: Omit<UpdateFormInput, 'definition'> & { definition?: FormDefinition },
      ) => patch<TypedForm>(form(formId), input as UpdateFormInput),
      remove: (formId: string) => del<Deleted>(form(formId)),
      duplicate: (formId: string) => post<TypedForm>(`${form(formId)}/duplicate`),
      archive: (formId: string) => post<TypedForm>(`${form(formId)}/archive`),
      restore: (formId: string) => post<TypedForm>(`${form(formId)}/restore`),
      embed: (formId: string) => get<FormEmbed>(`${form(formId)}/embed`),
    },
    submissions: {
      list: (
        formId: string,
        params: { cursor?: string; status?: SubmissionStatus; limit?: number } = {},
      ) => get<Page<FormSubmission>>(`${form(formId)}/submissions`, { limit: 50, ...params }),
      get: (formId: string, submissionId: string) =>
        get<FormSubmission>(`${form(formId)}/submissions/${id(submissionId)}`),
      remove: (formId: string, submissionId: string) =>
        del<Deleted>(`${form(formId)}/submissions/${id(submissionId)}`),
      reprocess: (formId: string, submissionId: string) =>
        post<FormSubmission>(`${form(formId)}/submissions/${id(submissionId)}/reprocess`),
      archivedMonths: (formId: string) => get<ArchivedMonths>(`${form(formId)}/archivedSubmissions`),
      archived: (formId: string, month: string, offset = 0) =>
        get<ArchivedSubmissions>(`${form(formId)}/archivedSubmissions/${id(month)}`, { offset, limit: 50 }),
    },
    connections: {
      catalog: () => get<{ data: ConnectorInfo[] }>('/formConnectorTypes'),
      list: (formId: string) => get<{ data: FormConnection[] }>(`${form(formId)}/connections`),
      create: (formId: string, input: CreateConnectionInput) =>
        post<FormConnectionWithSecret>(`${form(formId)}/connections`, input),
      update: (formId: string, connectionId: string, input: UpdateConnectionInput) =>
        patch<FormConnection>(`${form(formId)}/connections/${id(connectionId)}`, input),
      remove: (formId: string, connectionId: string) =>
        del<Deleted>(`${form(formId)}/connections/${id(connectionId)}`),
      test: (formId: string, connectionId: string) =>
        post<ConnectionTestResult>(`${form(formId)}/connections/${id(connectionId)}/test`),
      rotateSecret: (formId: string, connectionId: string) =>
        post<FormConnectionWithSecret>(
          `${form(formId)}/connections/${id(connectionId)}/rotateSecret`,
        ),
    },
    crm: {
      customFields: () => get<{ data: CustomField[] }>('/customFields/contact'),
      leadSources: () => get<{ data: LeadSource[] }>('/leadSources'),
    },
  };
}

export type FormsClient = ReturnType<typeof formsClient>;
