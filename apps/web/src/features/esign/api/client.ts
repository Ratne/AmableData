import type {
  Contact,
  CreateEsignRequestInput,
  CreateEsignTemplateInput,
  EsignRequest,
  EsignRequestDetail,
  EsignRequestStatus,
  EsignTemplate,
  Page,
  UpdateEsignTemplateInput,
} from '@amable/api-types';
import { buildQuery, tenantRest } from '../../../lib/tenant-api';

export { TenantApiError as EsignApiError } from '../../../lib/tenant-api';

/** Typed client of the e-signature REST v2 surface (`/api/v2/t/{slug}`): templates, files and requests. */

export interface ListRequestsParams {
  readonly status?: EsignRequestStatus;
  readonly template_id?: string;
  readonly contact_id?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export function esignClient(slug: string) {
  const { base, call, get, post, patch, del, me } = tenantRest(slug, { idempotent: false });
  const id = encodeURIComponent;
  const template = (templateId: string) => `/esignTemplates/${id(templateId)}`;
  const req = (requestId: string) => `/esignRequests/${id(requestId)}`;

  return {
    me,
    templates: {
      list: (query: { status?: EsignTemplate['status']; q?: string } = {}) =>
        get<Page<EsignTemplate>>('/esignTemplates', { limit: 200, ...query }),
      get: (templateId: string) => get<EsignTemplate>(template(templateId)),
      create: (input: CreateEsignTemplateInput) => post<EsignTemplate>('/esignTemplates', input),
      update: (templateId: string, input: UpdateEsignTemplateInput) =>
        patch<EsignTemplate>(template(templateId), input),
      remove: (templateId: string) => del(template(templateId)),
      uploadDocument: (templateId: string, file: Blob, filename: string) =>
        call<EsignTemplate>(`${template(templateId)}/document`, {
          method: 'PUT',
          raw: file,
          contentType: 'application/pdf',
          query: { filename },
        }),
      documentUrl: (templateId: string) => `${base}${template(templateId)}/document`,
      uploadPageImage: (templateId: string, page: number, image: Blob, sourceSha256: string) =>
        call<EsignTemplate>(`${template(templateId)}/pages/${String(page)}/image`, {
          method: 'PUT',
          raw: image,
          contentType: image.type || 'image/webp',
          query: { source_sha256: sourceSha256 },
        }),
      pageImageUrl: (templateId: string, page: number, version: string) =>
        `${base}${template(templateId)}/pages/${String(page)}/image?v=${encodeURIComponent(version)}`,
    },
    requests: {
      list: (params: ListRequestsParams = {}) =>
        get<Page<EsignRequest>>('/esignRequests', { limit: 100, ...params }),
      get: (requestId: string) => get<EsignRequestDetail>(req(requestId)),
      create: (input: CreateEsignRequestInput) => post<EsignRequest>('/esignRequests', input),
      void: (requestId: string, reason?: string) =>
        post<EsignRequest>(
          `${req(requestId)}/void`,
          reason === undefined || reason === '' ? {} : { reason },
        ),
      remind: (requestId: string, signerId?: string) =>
        post<EsignRequest>(
          `${req(requestId)}/remind`,
          signerId === undefined ? {} : { signer_id: signerId },
        ),
      finalize: (requestId: string) => post<EsignRequest>(`${req(requestId)}/finalize`),
      signerLink: (requestId: string, signerId: string) =>
        post<{ url: string }>(`${req(requestId)}/signers/${id(signerId)}/link`),
      documentUrl: (requestId: string, kind: 'completed' | 'original', download = false) =>
        `${base}${req(requestId)}/document${buildQuery({ kind, download: download ? 'true' : undefined })}`,
    },
    contacts: {
      search: (q: string) => get<Page<Contact>>('/contacts', { q: q || undefined, limit: 8 }),
      get: (contactId: string) => get<Contact>(`/contacts/${id(contactId)}`),
    },
  };
}

export type EsignClient = ReturnType<typeof esignClient>;
