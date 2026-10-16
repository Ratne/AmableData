import type { Form } from '@amable/api-types';
import type { SubmissionContent } from '../../src/forms/submissions';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestTenant, outbox, type TestTenant } from '../crm/helpers';
import { leadDefinition } from './helpers';

let t: TestTenant;
let tagId: string;
let leadSourceId: string;
let form: Form;
let seq = 0;

function content(values: SubmissionContent['values'], tracking: Record<string, string> = {}): SubmissionContent {
  return {
    values,
    tracking,
    meta: {
      page_url: 'https://www.example.com/landing?utm_source=google',
      referrer: 'https://google.com/',
      landing_url: '',
      first_referrer: '',
      page_id: '',
      visitor_id: 'vis_12345678',
      locale: 'it',
      time_zone: 'Europe/Rome',
      viewport: '',
    },
  };
}

/** Stores a pending submission (opaque ciphertext: the DO never decrypts) and applies it. */
function submit(values: SubmissionContent['values'], tracking: Record<string, string> = {}, formId = form.id) {
  seq += 1;
  const id = `sub_${String(seq).padStart(4, '0')}`;
  t.op('forms.storeSubmission', {
    id,
    formId,
    ciphertext: 'v1.opaque.opaque',
    visitorId: 'vis_12345678',
    country: 'IT',
    source: {
      utm_source: tracking['utm_source'] ?? null,
      utm_medium: tracking['utm_medium'] ?? null,
      utm_campaign: tracking['utm_campaign'] ?? null,
      utm_term: null,
      utm_content: null,
      referrer: 'https://google.com/',
      page_url: 'https://www.example.com/landing',
      page_id: null,
    },
  });
  const applied = t.op('forms.applySubmission', { id, ...content(values, tracking) });
  return { id, ...applied };
}

beforeEach(() => {
  t = createTestTenant();
  seq = 0;
  t.op('customFields.create', { entity: 'contact', data: { key: 'budget', label: 'Budget', type: 'WHOLE_NUMBER' } });
  tagId = t.op('tags.create', { name: 'Webinar lead' }).id;
  leadSourceId = t.op('leadSources.create', { name: 'Website form' }).id;
  form = t.op('forms.create', {
    name: 'Contact us',
    definition: { ...leadDefinition(), crm: { tag_ids: [tagId], lead_source_id: leadSourceId, owner_id: 'user_owner' } },
  });
});

describe('submission → contact mapping', () => {
  it('creates a contact with mapped fields, custom field, tags, lead source, UTM and consent', () => {
    const result = submit(
      {
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: 'Ada@Example.com',
        phone: '+39 333 123 4567',
        company: 'Analytical Engines',
        budget: 5000,
        notes: 'secret plans',
        news: true,
      },
      { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'spring' },
    );
    expect(result.contactCreated).toBe(true);
    const contact = t.op('contacts.get', { id: result.contactId ?? '' });
    expect(contact).toMatchObject({
      given_name: 'Ada',
      family_name: 'Lovelace',
      source_type: 'form',
      lead_source_id: leadSourceId,
      owner_id: 'user_owner',
      marketable_status: 'single_opt_in',
      utm: { source: 'google', medium: 'cpc', campaign: 'spring', term: null, content: null },
      emails: [{ email: 'ada@example.com', is_primary: true }],
      phones: [{ number: '+39 333 123 4567' }],
      custom_fields: { budget: 5000 },
      tag_ids: [tagId],
    });
    expect(contact.company_id).not.toBeNull();
    const submission = t.op('forms.getSubmission', { formId: form.id, id: result.id }).submission;
    expect(submission).toMatchObject({ status: 'processed', contact_id: result.contactId, contact_created: 1 });
  });

  it('emits form.submitted with the documented payload (sensitive fields omitted)', () => {
    const result = submit(
      { first_name: 'Ada', email: 'ada@example.com', notes: 'secret plans', news: true, budget: 10 },
      { utm_source: 'newsletter' },
    );
    const event = outbox(t).find((e) => e.type === 'form.submitted');
    expect(event?.payload).toEqual({
      formId: form.id,
      submissionId: result.id,
      contactId: result.contactId,
      contactCreated: true,
      fields: { first_name: 'Ada', email: 'ada@example.com', budget: '10', news: 'yes' },
      source: {
        utmSource: 'newsletter',
        utmMedium: null,
        utmCampaign: null,
        utmTerm: null,
        utmContent: null,
        referrer: 'https://google.com/',
        pageUrl: 'https://www.example.com/landing',
        pageId: null,
      },
      visitorId: 'vis_12345678',
    });
    const types = outbox(t).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['contact.created', 'contact.tag_applied', 'form.submitted']));
    const timeline = t.op('timeline', { subject: 'contact', id: result.contactId ?? '', limit: 50 });
    expect(timeline.data.map((a) => a.type)).toContain('form.submitted');
  });

  it('updates the contact found by email without overwriting values (fill_empty)', () => {
    const existing = t.op('contacts.create', {
      given_name: 'Augusta',
      emails: [{ email: 'ada@example.com' }],
      utm: { source: 'first-touch' },
      custom_fields: { budget: 100 },
      marketable_status: 'unsubscribed',
    });
    const result = submit(
      { first_name: 'Ada', last_name: 'Lovelace', email: 'ADA@example.com', phone: '+44 20 7946 0000', budget: 999, news: true },
      { utm_source: 'google', utm_medium: 'cpc' },
    );
    expect(result).toMatchObject({ contactId: existing.id, contactCreated: false });
    const contact = t.op('contacts.get', { id: existing.id });
    expect(contact).toMatchObject({
      given_name: 'Augusta',
      family_name: 'Lovelace',
      utm: { source: 'first-touch', medium: 'cpc' },
      custom_fields: { budget: 100 },
      marketable_status: 'unsubscribed',
      lead_source_id: leadSourceId,
      tag_ids: [tagId],
    });
    expect(contact.phones.map((p) => p.number)).toEqual(['+44 20 7946 0000']);
  });

  it('overwrites mapped values with the overwrite policy and matches by phone when there is no email match', () => {
    const existing = t.op('contacts.create', {
      given_name: 'Old',
      phones: [{ number: '+39 333 123 4567' }],
      custom_fields: { budget: 100 },
    });
    t.op('forms.update', {
      id: form.id,
      data: { definition: { ...leadDefinition(), crm: { update_policy: 'overwrite' } } },
    });
    const result = submit({ first_name: 'New', email: 'new@example.com', phone: '+39 (333) 123-4567', budget: 250 });
    expect(result.contactId).toBe(existing.id);
    const contact = t.op('contacts.get', { id: existing.id });
    expect(contact.given_name).toBe('New');
    expect(contact.custom_fields).toEqual({ budget: 250 });
    expect(contact.emails.map((e) => e.email)).toEqual(['new@example.com']);
  });

  it('keeps the lead when a custom value is invalid, with a warning', () => {
    const result = submit({ first_name: 'Ada', email: 'ada@example.com', budget: 12.5 });
    const contact = t.op('contacts.get', { id: result.contactId ?? '' });
    expect(contact.custom_fields).toEqual({});
    const submission = t.op('forms.getSubmission', { formId: form.id, id: result.id }).submission;
    expect(JSON.parse(submission.warnings)).toEqual([expect.stringContaining('budget')]);
  });

  it('records no contact when no email or phone is mapped, and is idempotent', () => {
    const anonymous = t.op('forms.create', {
      name: 'Survey',
      definition: { fields: [{ id: 'q', kind: 'text', key: 'answer', label: 'Answer' }] },
    });
    const result = submit({ answer: 'blue' }, {}, anonymous.id);
    expect(result).toMatchObject({ contactId: null, contactCreated: false, alreadyProcessed: false });
    const again = t.op('forms.applySubmission', { id: result.id, ...content({ answer: 'blue' }) });
    expect(again.alreadyProcessed).toBe(true);
    expect(outbox(t).filter((e) => e.type === 'form.submitted')).toHaveLength(1);
  });

  it('rejects submissions to archived forms and validates definitions', () => {
    t.op('forms.archive', { id: form.id });
    expect(() => submit({ email: 'a@b.co' })).toThrow(/not_found/);
    expect(() =>
      t.op('forms.update', { id: form.id, data: { definition: { crm: { tag_ids: ['missing'] } } } }),
    ).toThrow(/validation_failed/);
    expect(() =>
      t.op('forms.update', { id: form.id, data: { definition: { fields: [{ id: 'a', kind: 'select', key: 'x' }] } } }),
    ).toThrow(/definition\.fields\.0\.options|add at least one option/);
  });
});
