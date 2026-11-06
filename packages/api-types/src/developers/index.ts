/** Contracts of the developer settings: webhook endpoints and deliveries, tenant domains (`/api/v2/t/:slug`). */

export type WebhookEndpointStatus = 'active' | 'disabled';
export type WebhookDeliveryStatus = 'pending' | 'retrying' | 'succeeded' | 'failed';

export interface WebhookEndpoint {
  readonly id: string;
  readonly url: string;
  readonly description: string;
  readonly event_types: string[];
  readonly status: WebhookEndpointStatus;
  readonly disabled_reason: string | null;
  readonly consecutive_failures: number;
  readonly secret_hint: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_success_at: string | null;
  readonly last_failure_at: string | null;
}

export interface WebhookDelivery {
  readonly id: string;
  readonly endpoint_id: string;
  readonly event_id: string;
  readonly event_type: string;
  readonly status: WebhookDeliveryStatus;
  readonly attempts: number;
  readonly next_attempt_at: string | null;
  readonly last_status: number | null;
  readonly last_error: string | null;
  readonly duration_ms: number | null;
  readonly replay_of: string | null;
  readonly created_at: string;
  readonly completed_at: string | null;
}

export interface WebhookDeliveryDetail extends WebhookDelivery {
  readonly payload: unknown;
  readonly last_response: string | null;
}

export type DomainKind = 'sending' | 'tracking' | 'app' | 'shortlink';
export type DomainStatus = 'pending' | 'verified' | 'failed';

export interface DomainDnsRecord {
  readonly type: 'TXT' | 'CNAME' | 'MX';
  readonly name: string;
  readonly value: string;
  /** TXT written only when the name has no TXT starting with this prefix (one DMARC policy per name). */
  readonly unlessPrefix?: string;
}

export interface TenantDomain {
  readonly id: string;
  readonly hostname: string;
  readonly kind: DomainKind;
  readonly status: DomainStatus;
  readonly records: DomainDnsRecord[];
  readonly paths: string[];
  /** Workers Routes patterns (site with paths). */
  readonly routes: string[];
  readonly zone_id: string | null;
  readonly dns_applied_at: string | null;
  readonly verified_at: string | null;
  readonly checked_at: string | null;
  readonly last_error: string | null;
  /** Sending: the provider changed the records (cluster move); publish them and verify again. */
  readonly dns_changed_at: string | null;
  readonly created_at: string;
}
