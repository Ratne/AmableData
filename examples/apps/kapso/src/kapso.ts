/**
 * Kapso API: one project API key (`X-API-Key`) for both surfaces.
 * - Platform API: numbers, customers and setup links, webhooks, contacts.
 * - WhatsApp API: Meta's Cloud API proxied by Kapso (messages, templates).
 * https://docs.kapso.ai/api/introduction
 */

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export const PLATFORM_URL = 'https://api.kapso.ai/platform/v1';
export const WHATSAPP_URL = 'https://api.kapso.ai/meta/whatsapp/v24.0';
const TIMEOUT_MS = 8_000;

export const WEBHOOK_EVENTS = [
  'whatsapp.message.received',
  'whatsapp.message.sent',
  'whatsapp.message.delivered',
  'whatsapp.message.read',
  'whatsapp.message.failed',
  'whatsapp.contact.marketing_preference_changed',
] as const;

export class KapsoError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }

  /** Kapso or Meta may succeed on retry. */
  get transient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export interface PhoneNumber {
  readonly phone_number_id: string;
  readonly business_account_id: string | null;
  readonly display_phone_number: string | null;
  readonly name: string | null;
  /** `sandbox` numbers only send text to activated sessions: no templates. */
  readonly kind: string | null;
}

export interface MetaTemplateComponent {
  readonly type: string;
  readonly format?: string;
  readonly text?: string;
  readonly example?: Record<string, unknown>;
  readonly buttons?: ReadonlyArray<{
    type: string;
    text?: string;
    url?: string;
    phone_number?: string;
    example?: unknown;
  }>;
}

export interface MetaTemplate {
  readonly id: string;
  readonly name: string;
  readonly language: string;
  readonly status: string;
  readonly category: string;
  readonly parameter_format?: string;
  readonly rejected_reason?: string;
  readonly components: readonly MetaTemplateComponent[];
}

function errorText(body: unknown, status: number): string {
  if (body !== null && typeof body === 'object') {
    const error = (body as Record<string, unknown>)['error'];
    if (typeof error === 'string') return error;
    if (error !== null && typeof error === 'object') {
      const message = (error as Record<string, unknown>)['message'];
      if (typeof message === 'string') return message;
    }
    const message = (body as Record<string, unknown>)['message'];
    if (typeof message === 'string') return message;
  }
  return `Kapso answered HTTP ${String(status)}`;
}

function phoneNumberOf(raw: Record<string, unknown>): PhoneNumber {
  const str = (key: string) =>
    typeof raw[key] === 'string' && raw[key] !== '' ? (raw[key] as string) : null;
  return {
    phone_number_id: String(raw['phone_number_id'] ?? raw['id']),
    business_account_id: str('business_account_id'),
    display_phone_number: str('display_phone_number'),
    name: str('name') ?? str('display_name'),
    kind: str('kind'),
  };
}

export function kapsoClient(apiKey: string, fetcher: Fetch) {
  async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(url, {
        method,
        headers: {
          'X-API-Key': apiKey,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new KapsoError(0, 'Kapso did not answer in time');
    }
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!response.ok) throw new KapsoError(response.status, errorText(parsed, response.status));
    return parsed as T;
  }
  const platform = <T>(method: string, path: string, body?: unknown) =>
    call<T>(method, `${PLATFORM_URL}${path}`, body);
  const whatsapp = <T>(method: string, path: string, body?: unknown) =>
    call<T>(method, `${WHATSAPP_URL}${path}`, body);

  return {
    async phoneNumbers(): Promise<PhoneNumber[]> {
      const body = await platform<{ data: Record<string, unknown>[] }>(
        'GET',
        '/whatsapp/phone_numbers?per_page=100',
      );
      return body.data.map(phoneNumberOf);
    },
    async phoneNumber(id: string): Promise<PhoneNumber | null> {
      const body = await platform<{ data: Record<string, unknown>[] }>(
        'GET',
        `/whatsapp/phone_numbers?${new URLSearchParams({ phone_number_id: id }).toString()}`,
      );
      const found = body.data.find((n) => String(n['phone_number_id'] ?? n['id']) === id);
      return found === undefined ? null : phoneNumberOf(found);
    },
    /** The Kapso customer that owns the numbers connected from one workspace. */
    async customerFor(externalId: string, name: string): Promise<string> {
      const found = await platform<{ data: Array<{ id: string }> }>(
        'GET',
        `/customers?${new URLSearchParams({ external_customer_id: externalId }).toString()}`,
      );
      if (found.data[0] !== undefined) return found.data[0].id;
      const created = await platform<{ data: { id: string } }>('POST', '/customers', {
        customer: { name, external_customer_id: externalId },
      });
      return created.data.id;
    },
    /** Hosted onboarding (Meta embedded signup) for a new or coexisting number. */
    async createSetupLink(
      customerId: string,
      redirects: { success: string; failure: string },
    ): Promise<{ id: string; url: string }> {
      const body = await platform<{ data: { id: string; url: string } }>(
        'POST',
        `/customers/${encodeURIComponent(customerId)}/setup_links`,
        {
          setup_link: {
            success_redirect_url: redirects.success,
            failure_redirect_url: redirects.failure,
          },
        },
      );
      return { id: body.data.id, url: body.data.url };
    },
    async createWebhook(phoneNumberId: string, url: string, secret: string): Promise<string> {
      const body = await platform<{ data: { id: string } }>(
        'POST',
        `/whatsapp/phone_numbers/${encodeURIComponent(phoneNumberId)}/webhooks`,
        {
          whatsapp_webhook: {
            kind: 'kapso',
            url,
            events: WEBHOOK_EVENTS,
            secret_key: secret,
            active: true,
          },
        },
      );
      return body.data.id;
    },
    async deleteWebhook(phoneNumberId: string, webhookId: string): Promise<void> {
      try {
        await platform(
          'DELETE',
          `/whatsapp/phone_numbers/${encodeURIComponent(phoneNumberId)}/webhooks/${encodeURIComponent(webhookId)}`,
        );
      } catch (error) {
        if (!(error instanceof KapsoError && error.status === 404)) throw error;
      }
    },
    /** Every template of the WhatsApp Business Account (all statuses), up to 500. */
    async templates(wabaId: string): Promise<MetaTemplate[]> {
      const out: MetaTemplate[] = [];
      let after: string | null = null;
      for (let page = 0; page < 5; page += 1) {
        const query = new URLSearchParams({ limit: '100', ...(after === null ? {} : { after }) });
        const body: {
          data: MetaTemplate[];
          paging?: { cursors?: { after?: string }; next?: string };
        } = await whatsapp(
          'GET',
          `/${encodeURIComponent(wabaId)}/message_templates?${query.toString()}`,
        );
        out.push(...body.data);
        after = body.paging?.next !== undefined ? (body.paging.cursors?.after ?? null) : null;
        if (after === null) break;
      }
      return out;
    },
    template: (wabaId: string, id: string) =>
      whatsapp<MetaTemplate>(
        'GET',
        `/${encodeURIComponent(wabaId)}/message_templates/${encodeURIComponent(id)}`,
      ),
    createTemplate: (wabaId: string, template: Record<string, unknown>) =>
      whatsapp<{ id: string; status: string; category: string }>(
        'POST',
        `/${encodeURIComponent(wabaId)}/message_templates`,
        template,
      ),
    /** By name: every language of the template goes. */
    deleteTemplate: (wabaId: string, name: string) =>
      whatsapp<{ success: boolean }>(
        'DELETE',
        `/${encodeURIComponent(wabaId)}/message_templates?${new URLSearchParams({ name }).toString()}`,
      ),
    async send(
      phoneNumberId: string,
      message: Record<string, unknown>,
    ): Promise<{ id: string; waId: string | null }> {
      const body = await whatsapp<{
        messages?: Array<{ id: string }>;
        contacts?: Array<{ wa_id?: string }>;
      }>('POST', `/${encodeURIComponent(phoneNumberId)}/messages`, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        ...message,
      });
      const id = body.messages?.[0]?.id;
      if (id === undefined) throw new KapsoError(502, 'Kapso accepted the message without an id');
      return { id, waId: body.contacts?.[0]?.wa_id ?? null };
    },
    /** GDPR erasure of a WhatsApp contact (queued by Kapso). */
    async eraseContact(e164: string): Promise<void> {
      try {
        await platform('DELETE', `/whatsapp/contacts/${encodeURIComponent(e164)}`);
      } catch (error) {
        if (!(error instanceof KapsoError && error.status === 404)) throw error;
      }
    },
  };
}

export type KapsoClient = ReturnType<typeof kapsoClient>;

/** WhatsApp addresses are digits only: `+39 333 123 4567` and `0039…` become `393331234567`. */
export function waNumber(phone: string): string | null {
  let digits = phone.replace(/\D/g, '');
  if (phone.trim().startsWith('00')) digits = digits.slice(2);
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}
