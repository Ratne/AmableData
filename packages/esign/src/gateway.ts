import type {
  OtpSendResult,
  OtpVerifyResult,
  SigningBrowserFacts,
  SigningSubmit,
  SigningView,
} from './types';

/**
 * Edge ↔ core gateway ops of the signing page (structurally a `GatewayOpMap`
 * of @amable/api-types). The edge serves `/sign.js` and `/sign/:slug/:token`;
 * the core worker checks the link and records every action in the audit trail.
 */
export type EsignGatewayOps = {
  /** Signing page facts (no audit event: the app reports `open` once it runs). */
  'esign.view': {
    input: { token: string; locale?: string };
    output: SigningView;
  };
  /** The page was displayed: records `opened` with the browser facts. */
  'esign.open': {
    input: { token: string; browser?: SigningBrowserFacts };
    output: SigningView;
  };
  /** Emails a 6-digit code (templates that require it). */
  'esign.otpSend': {
    input: { token: string; browser?: SigningBrowserFacts };
    output: OtpSendResult;
  };
  'esign.otpVerify': {
    input: { token: string; code: string; browser?: SigningBrowserFacts };
    output: OtpVerifyResult;
  };
  'esign.complete': {
    input: { token: string; submit: SigningSubmit };
    output: SigningView;
  };
  'esign.decline': {
    input: { token: string; reason?: string; browser?: SigningBrowserFacts };
    output: SigningView;
  };
};

export const ESIGN_GATEWAY_OPS = [
  'esign.view',
  'esign.open',
  'esign.otpSend',
  'esign.otpVerify',
  'esign.complete',
  'esign.decline',
] as const satisfies ReadonlyArray<keyof EsignGatewayOps>;

/** Raw op: page image of the document (`{ token, page }`). */
export const ESIGN_PAGE_RAW_OP = 'esign.page';
/** Raw op: the PDF (`{ token }`): the completed one when ready, the original otherwise. */
export const ESIGN_DOCUMENT_RAW_OP = 'esign.document';

/** Signing links: `/sign/:slug/:token`. */
export const SIGNING_TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;
/** The sign action carries signature images: larger than other public bodies. */
export const SIGNING_SUBMIT_MAX_BYTES = 900_000;
