/**
 * Domain events of the publishing modules living in the TenantDb (forms,
 * bookings, landing pages). Like CRM events they are written to the tenant
 * outbox in the same transaction as the change.
 *
 * Booking cancellations reuse the CRM `appointment.cancelled` event (the
 * booking's appointment is a regular CRM appointment).
 */

/** Attribution captured with a submission or a booking (hidden fields, page URL, referrer). */
export interface PublicSourceFacts {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  referrer: string | null;
  /** URL of the page the form / booking widget was on. */
  pageUrl: string | null;
  /** Landing page id when submitted from a published amable page. */
  pageId: string | null;
}

export interface BookingFacts {
  appointmentId: string;
  bookingId: string;
  eventTypeId: string;
  calendarId: string;
  contactId: string;
  /** Host user (owner of the appointment). */
  ownerId: string | null;
  /** ISO 8601 (UTC). */
  startsAt: string;
  endsAt: string;
  /** IANA time zone of the invitee. */
  timeZone: string;
}

export interface PublishingEventPayloads {
  'form.submitted': {
    formId: string;
    submissionId: string;
    /** Null when the form maps no email/phone, so no contact could be matched or created. */
    contactId: string | null;
    contactCreated: boolean;
    /** Field key → display value, truncated; sensitive fields are omitted. */
    fields: Record<string, string>;
    source: PublicSourceFacts;
    /** Analytics visitor id (tracker cookie or hidden field), when present. */
    visitorId: string | null;
  };
  'appointment.booked': BookingFacts & { source: PublicSourceFacts; visitorId: string | null };
  'appointment.rescheduled': BookingFacts & { previousStartsAt: string; previousEndsAt: string };
  'page.published': {
    pageId: string;
    versionId: string;
    version: number;
    path: string;
    host: string | null;
  };
  'page.unpublished': { pageId: string; path: string; host: string | null };
}

export type PublishingEventType = keyof PublishingEventPayloads;

export const PUBLISHING_EVENT_TYPES = [
  'form.submitted',
  'appointment.booked',
  'appointment.rescheduled',
  'page.published',
  'page.unpublished',
] as const satisfies readonly PublishingEventType[];

type MissingPublishingEvent = Exclude<PublishingEventType, (typeof PUBLISHING_EVENT_TYPES)[number]>;
const publishingEventListIsComplete: MissingPublishingEvent extends never ? true : never = true;
void publishingEventListIsComplete;
