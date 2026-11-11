import type { OpsReplay, OpsStatus } from '@amable/api-types';
import { request } from '../../lib/tenant-api';

export const opsKeys = {
  status: (slug: string) => ['ops', slug, 'status'] as const,
};

const base = (slug: string) => `/api/v2/t/${encodeURIComponent(slug)}/ops`;

export const opsApi = {
  status: (slug: string) => request<OpsStatus>(`${base(slug)}/status`),
  replayRegistry: (slug: string) =>
    request<OpsReplay>(`${base(slug)}/registry/replay`, { method: 'POST', json: {} }),
};
