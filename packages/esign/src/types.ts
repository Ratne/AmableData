/** Shared, zod-free types of the public signing flow (core gateway, edge routes and the signing app). */

export type EsignLocale = 'en' | 'it';

export type SigningFieldType =
  | 'signature'
  | 'initials'
  | 'text'
  | 'number'
  | 'date'
  | 'checkbox'
  | 'select'
  | 'radio'
  | 'image'
  | 'signed_date';

export const SIGNING_IMAGE_TYPES: readonly SigningFieldType[] = ['signature', 'initials', 'image'];

/**
 * Facts the signing app reads from the browser and sends with every action:
 * stored on each audit event next to IP, user agent and country (taken by
 * the edge from the request).
 */
export interface SigningBrowserFacts {
  time_zone?: string;
  /** Local time of the device when the action happened (ISO with offset). */
  local_time?: string;
  languages?: string[];
  platform?: string;
  screen?: string;
  viewport?: string;
  pixel_ratio?: number;
  color_depth?: number;
  touch_points?: number;
  hardware_concurrency?: number;
  device_memory?: number;
  cookies_enabled?: boolean;
  do_not_track?: string;
  webdriver?: boolean;
  referrer?: string;
}

export interface SigningPage {
  index: number;
  /** PDF points: the aspect ratio of the page. */
  width: number;
  height: number;
}

/** Rectangle normalized to the page (0..1, origin top-left). */
export interface SigningRect {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SigningOwnField extends SigningRect {
  id: string;
  type: SigningFieldType;
  required: boolean;
  label: string;
  options: string[];
}

/** Field of another party, shown read-only (its text once that party signed). */
export interface SigningOtherField extends SigningRect {
  id: string;
  type: SigningFieldType;
  party_name: string;
  color: string | null;
  filled: boolean;
  text: string | null;
}

/** Where the signer stands. */
export type SigningState =
  | 'ready'
  /** Sequential order: an earlier party has not signed yet. */
  | 'waiting'
  | 'signed'
  | 'declined'
  /** Every party signed. */
  | 'completed'
  /** Another party declined, the sender voided it, or it expired. */
  | 'closed';

export interface SigningView {
  tenant_name: string;
  request_name: string;
  message: string;
  locale: EsignLocale;
  state: SigningState;
  closed_reason: 'declined' | 'voided' | 'expired' | null;
  signer: { name: string; email: string; party_name: string };
  expires_at: string | null;
  otp: { required: boolean; verified: boolean; email_hint: string };
  pages: SigningPage[];
  fields: SigningOwnField[];
  others: SigningOtherField[];
  /** Text values this signer submitted (after signing). */
  values: Record<string, string | boolean>;
  /** The completed PDF can be downloaded. */
  document_ready: boolean;
  consent: { version: string; text: string };
}

/** Body of the sign action: images are `data:image/png|jpeg;base64,…` URLs. */
export interface SigningSubmit {
  values: Record<string, string | boolean>;
  /** How each image field was produced. */
  methods?: Record<string, 'drawn' | 'typed' | 'upload'>;
  consent: boolean;
  consent_version: string;
  browser?: SigningBrowserFacts;
}

export interface OtpSendResult {
  sent: boolean;
  /** Seconds before another code can be requested. */
  retry_after: number;
}

export interface OtpVerifyResult {
  verified: boolean;
  attempts_left: number;
  /** No valid code: request a new one. */
  expired: boolean;
}
