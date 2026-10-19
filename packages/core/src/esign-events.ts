/**
 * Domain events of electronic signatures, written to the tenant outbox in the
 * same transaction as the change. Every event names one signer's contact, so
 * it lands on that contact's timeline and enrolls that contact in automations.
 */

interface EsignSignerFacts {
  requestId: string;
  templateId: string;
  signerId: string;
  /** Null only when the contact was deleted after the request was sent. */
  contactId: string | null;
  partyId: string;
}

export interface EsignEventPayloads {
  /** The signing invitation was queued for this signer. */
  'esign.signer_notified': EsignSignerFacts;
  'esign.signer_signed': EsignSignerFacts;
  /** Every party signed: emitted once per signer. */
  'esign.request_completed': EsignSignerFacts;
  /** The signer declined; the request ends for every party. */
  'esign.request_declined': EsignSignerFacts & { reason: string | null };
}

export type EsignOutboxEventType = keyof EsignEventPayloads;

export const ESIGN_OUTBOX_EVENT_TYPES = [
  'esign.signer_notified',
  'esign.signer_signed',
  'esign.request_completed',
  'esign.request_declined',
] as const satisfies readonly EsignOutboxEventType[];

type MissingEsignEvent = Exclude<EsignOutboxEventType, (typeof ESIGN_OUTBOX_EVENT_TYPES)[number]>;
const esignEventListIsComplete: MissingEsignEvent extends never ? true : never = true;
void esignEventListIsComplete;
