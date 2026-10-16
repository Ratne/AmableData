import type {
  Automation,
  AutomationDetail,
  AutomationGraph,
  AutomationSettings,
  AutomationStats,
  AutomationStatus,
  AutomationVersion,
  AutomationVersionSummary,
  Enrollment,
  EnrollmentDetail,
  PublishResult,
  ValidationResult,
} from '@amable/api-types';
import type { Contact, Page } from '@amable/api-types/crm';
import { request } from '../../crm/api/client';

/**
 * Typed client of the automation REST v2 surface (`/api/v2/t/{slug}/automations…`)
 * plus the few lookups the builder pickers need. Errors are `CrmApiError`
 * (shared request helper of the CRM pages: CSRF, idempotency key, 401 redirect).
 */

export interface NamedRef {
  readonly id: string;
  readonly name: string;
}

interface Listed {
  readonly id: string;
  readonly name?: string;
  readonly title?: string;
  readonly subject?: string;
  readonly domain?: string;
}

export function automationClient(slug: string) {
  const base = `/api/v2/t/${encodeURIComponent(slug)}`;
  const id = (value: string) => encodeURIComponent(value);
  const one = (automationId: string) => `${base}/automations/${id(automationId)}`;

  return {
    list: (
      params: {
        limit?: number;
        cursor?: string;
        status?: AutomationStatus;
        folder_id?: string;
        include_subfolders?: 'true';
      } = {},
    ) =>
      request<Page<Automation>>(`${base}/automations`, { query: { limit: 200, ...params } }),
    get: (automationId: string) => request<AutomationDetail>(one(automationId)),
    create: (input: {
      name: string;
      description?: string | null;
      graph?: AutomationGraph;
      settings?: AutomationSettings;
      folder_id?: string | null;
    }) => request<AutomationDetail>(`${base}/automations`, { method: 'POST', json: input }),
    update: (
      automationId: string,
      input: { name?: string; description?: string | null; settings?: AutomationSettings },
    ) => request<AutomationDetail>(one(automationId), { method: 'PATCH', json: input }),
    remove: (automationId: string) =>
      request<{ id: string; deleted: true }>(one(automationId), { method: 'DELETE' }),
    saveDraft: (automationId: string, graph: AutomationGraph, revision: number) =>
      request<AutomationDetail>(`${one(automationId)}/draft`, {
        method: 'PUT',
        json: { graph, revision },
      }),
    validate: (automationId: string) =>
      request<ValidationResult>(`${one(automationId)}/validate`, { method: 'POST', json: {} }),
    publish: (automationId: string) =>
      request<PublishResult>(`${one(automationId)}/publish`, { method: 'POST', json: {} }),
    unpublish: (automationId: string) =>
      request<Automation>(`${one(automationId)}/unpublish`, { method: 'POST', json: {} }),
    versions: (automationId: string) =>
      request<{ data: AutomationVersionSummary[] }>(`${one(automationId)}/versions`),
    version: (automationId: string, versionId: string) =>
      request<AutomationVersion>(`${one(automationId)}/versions/${id(versionId)}`),
    restoreVersion: (automationId: string, versionId: string) =>
      request<AutomationDetail>(`${one(automationId)}/versions/${id(versionId)}/restore`, {
        method: 'POST',
        json: {},
      }),
    enrollments: (
      automationId: string,
      params: {
        limit?: number;
        cursor?: string;
        status?: Enrollment['status'];
        node_id?: string;
        contact_id?: string;
        scope?: 'current' | 'visited';
      },
    ) =>
      request<Page<Enrollment>>(`${one(automationId)}/enrollments`, {
        query: { limit: 50, ...params },
      }),
    enrollment: (automationId: string, enrollmentId: string) =>
      request<EnrollmentDetail>(`${one(automationId)}/enrollments/${id(enrollmentId)}`),
    enroll: (automationId: string, input: { contact_id: string; node_id?: string }) =>
      request<Enrollment>(`${one(automationId)}/enrollments`, { method: 'POST', json: input }),
    removeContact: (automationId: string, contactId: string) =>
      request<{ contact_id: string; removed: boolean }>(
        `${one(automationId)}/contacts/${id(contactId)}`,
        { method: 'DELETE' },
      ),
    stats: (automationId: string) => request<AutomationStats>(`${one(automationId)}/stats`),
    signingSecret: (automationId: string) =>
      request<{ automation_id: string; secret: string }>(`${one(automationId)}/signing-secret`),
    rotateSigningSecret: (automationId: string) =>
      request<{ automation_id: string; secret: string }>(
        `${one(automationId)}/signing-secret/rotate`,
        {
          method: 'POST',
          json: {},
        },
      ),
    engineSettings: () => request<{ time_zone: string }>(`${base}/automationSettings`),

    contacts: (q: string) =>
      request<Page<Contact>>(`${base}/contacts`, { query: { q, limit: 20 } }),
    contact: (contactId: string) => request<Contact>(`${base}/contacts/${id(contactId)}`),
    /**
     * Generic reference list (`{ data: [{ id, name|title|subject }] }`) for
     * pickers of other modules (forms, products, templates, sites…).
     */
    references: async (path: string): Promise<NamedRef[]> => {
      const page = await request<{ data: Listed[] }>(`${base}${path}`, { query: { limit: 100 } });
      return page.data.map((row) => ({
        id: row.id,
        name: row.name ?? row.title ?? row.subject ?? row.domain ?? row.id,
      }));
    },
  };
}

export type AutomationClient = ReturnType<typeof automationClient>;
