import type { Assignment, BookingAnswers, BookingLocaleSetting, PhoneMode, QuestionKind } from './types';

/** Public JSON of the booking page / widget (never includes CRM mapping, tags or templates). */

export interface PublicQuestion {
  readonly key: string;
  readonly label: string;
  readonly kind: QuestionKind;
  readonly required: boolean;
  readonly options: readonly string[];
  readonly placeholder: string;
}

export interface PublicBookingConfig {
  readonly tenant: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly duration_minutes: number;
  readonly location: string;
  readonly color: string;
  readonly host_names: readonly string[];
  readonly assignment: Assignment;
  /** Time zone of the (first) host calendar; the widget defaults to the visitor's. */
  readonly time_zone: string;
  readonly locale: BookingLocaleSetting;
  readonly phone: PhoneMode;
  readonly questions: readonly PublicQuestion[];
  readonly max_days_ahead: number;
  readonly success_message: string;
  readonly redirect_url: string;
  readonly turnstile_site_key: string | null;
}

export interface PublicSlot {
  /** ISO 8601, UTC. */
  readonly start: string;
  readonly end: string;
}

export interface PublicSlotsResult {
  /** Time zone used to interpret `from` / `to`. */
  readonly time_zone: string;
  /** Availability version: changes whenever a host calendar changes. */
  readonly version: number;
  readonly slots: readonly PublicSlot[];
}

export interface BookingTracking {
  readonly utm_source?: string;
  readonly utm_medium?: string;
  readonly utm_campaign?: string;
  readonly utm_term?: string;
  readonly utm_content?: string;
}

export interface BookPayload {
  /** ISO 8601 start chosen among the offered slots. */
  readonly start: string;
  readonly time_zone: string;
  readonly locale?: string;
  readonly given_name: string;
  readonly family_name?: string;
  readonly email: string;
  readonly phone?: string;
  readonly answers?: BookingAnswers;
  /** Honeypot: must stay empty. */
  readonly hp?: string;
  readonly turnstile_token?: string;
  readonly tracking?: BookingTracking;
  readonly meta?: {
    readonly page_url?: string;
    readonly referrer?: string;
    readonly page_id?: string;
    readonly visitor_id?: string;
  };
}

export interface BookResult {
  readonly ok: true;
  readonly booking_id: string;
  readonly start: string;
  readonly end: string;
  readonly time_zone: string;
  readonly title: string;
  readonly host_names: readonly string[];
  /** Hosted page where the invitee can cancel or reschedule. */
  readonly manage_url: string;
  readonly success_message: string;
  readonly redirect_url: string;
}

export interface ManageView {
  readonly booking_id: string;
  readonly status: 'confirmed' | 'cancelled';
  readonly start: string;
  readonly end: string;
  readonly time_zone: string;
  readonly invitee_name: string;
  readonly cancelled_at: string | null;
  /** False once the booking has started or was cancelled. */
  readonly can_change: boolean;
  readonly config: PublicBookingConfig;
}
