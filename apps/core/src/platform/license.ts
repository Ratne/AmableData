import { parseLicenseKey } from '@amable/core/platform';
import type { Env } from '../env';

export const DEFAULT_CONTROL_PLANE_URL = 'https://app.amabledata.com';

/**
 * How this installation relates to the platform:
 * - `managed` / `linked`: a license key is configured (managed offering, or an open
 *   source installation linked to an account to buy credits);
 * - `open_source`: no license → every platform feature degrades to local behavior.
 */
export type PlatformLink =
  | {
      readonly mode: 'licensed';
      readonly installationId: string;
      readonly licenseKey: string;
      readonly controlPlaneUrl: string;
    }
  | { readonly mode: 'open_source' };

export function platformLink(env: Env): PlatformLink {
  const key = env.LICENSE_KEY?.trim() ?? '';
  const parsed = key === '' ? null : parseLicenseKey(key);
  if (parsed === null) return { mode: 'open_source' };
  return {
    mode: 'licensed',
    installationId: parsed.installationId,
    licenseKey: parsed.key,
    controlPlaneUrl: (env.CONTROL_PLANE_URL ?? DEFAULT_CONTROL_PLANE_URL).replace(/\/$/, ''),
  };
}
