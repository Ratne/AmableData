/**
 * @amable/esign — public signing flow: shared types, signer-facing strings
 * (en/it), the versioned consent text and the edge ↔ core gateway op types.
 * The signing app (preact) lives in `src/widget` and ships prebuilt through
 * `@amable/esign/bundle`.
 */

export * from './types';
export * from './consent';
export * from './strings';
export type { EsignGatewayOps } from './gateway';
export {
  ESIGN_DOCUMENT_RAW_OP,
  ESIGN_GATEWAY_OPS,
  ESIGN_PAGE_RAW_OP,
  SIGNING_SUBMIT_MAX_BYTES,
  SIGNING_TOKEN_RE,
} from './gateway';
