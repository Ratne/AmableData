import type {
  GeneralSettings,
  UpdateGeneralSettingsInput,
  WorkspaceProfile,
} from '@amable/api-types';
import { useQuery } from '@tanstack/react-query';
import { useDefaultPhoneCountry } from '../../components/locale/phone-input';
import { request } from '../crm/api/client';
import { useTenantSlug } from '../crm/api/hooks';

const base = (slug: string) => `/api/v2/t/${encodeURIComponent(slug)}`;

export const workspaceKeys = {
  profile: (slug: string) => ['workspace', slug, 'profile'] as const,
  general: (slug: string) => ['workspace', slug, 'general'] as const,
};

export const workspaceApi = {
  profile: (slug: string) => request<WorkspaceProfile>(`${base(slug)}/workspace`),
  general: (slug: string) => request<GeneralSettings>(`${base(slug)}/settings/general`),
  update: (slug: string, body: UpdateGeneralSettingsInput) =>
    request<GeneralSettings>(`${base(slug)}/settings/general`, { method: 'PATCH', json: body }),
  uploadLogo: (slug: string, file: File) =>
    request<GeneralSettings>(`${base(slug)}/settings/general/logo`, { method: 'PUT', raw: file }),
  removeLogo: (slug: string) =>
    request<GeneralSettings>(`${base(slug)}/settings/general/logo`, { method: 'DELETE' }),
};

/** Shell branding and defaults of new records; every member may read it. */
export function useWorkspaceProfile(slug: string) {
  return useQuery({
    queryKey: workspaceKeys.profile(slug),
    queryFn: () => workspaceApi.profile(slug),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Country of new addresses and phone numbers: the workspace default, else guessed from the browser. */
export function useWorkspaceCountry(): string {
  const fallback = useDefaultPhoneCountry();
  const profile = useWorkspaceProfile(useTenantSlug());
  return profile.data?.country_code ?? fallback;
}
