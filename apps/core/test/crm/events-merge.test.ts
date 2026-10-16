import { CRM_EVENT_TYPES } from '@amable/core';
import { describe, expect, it } from 'vitest';
import type { SqlValue } from '../../src/crm/db/sql';
import { createTestTenant, outbox, USER_ACTOR } from './helpers';

const doc = (text: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

describe('event outbox', () => {
  it('emits typed events for every mutation, in order, with the actor', () => {
    const t = createTestTenant();
    const vip = t.op('tags.create', { name: 'VIP' });
    const contact = t.op('contacts.create', {
      given_name: 'Ada',
      emails: [{ email: 'ada@example.com' }],
      tag_ids: [vip.id],
      owner_id: 'u2',
    });
    t.op('contacts.update', { id: contact.id, data: { family_name: 'Lovelace', score_value: 50 } });
    t.op('contacts.update', { id: contact.id, data: { family_name: 'Lovelace' } }); // no-op: no event
    t.op('contacts.removeTag', { id: contact.id, tagId: vip.id });
    t.op('tags.apply', { tagId: vip.id, contactIds: [contact.id, 'missing'] });
    const note = t.op('notes.create', {
      contact_id: contact.id,
      body: doc('Met at the conference'),
    });
    const task = t.op('tasks.create', { title: 'Call back', contact_id: contact.id });
    t.op('tasks.complete', { id: task.id });
    t.op('tasks.complete', { id: task.id }); // idempotent: no second event
    const pipeline = t.op('pipelines.create', { name: 'Sales' });
    const opp = t.op('opportunities.create', { title: 'Deal', contact_id: contact.id });
    const won = pipeline.stages.find((s) => s.kind === 'won')!;
    t.op('opportunities.update', { id: opp.id, data: { stage_id: won.id, value_minor: 1000 } });
    const appt = t.op('appointments.create', {
      title: 'Demo',
      contact_id: contact.id,
      start_at: '2026-10-20T09:00:00Z',
      end_at: '2026-10-20T10:00:00Z',
    });
    t.op('appointments.update', { id: appt.id, data: { status: 'cancelled' } });
    t.op('contacts.delete', { id: contact.id });
    t.op('contacts.restore', { id: contact.id });

    const events = outbox(t);
    expect(events.map((e) => e.type)).toEqual([
      'contact.created',
      'contact.owner_assigned',
      'contact.tag_applied',
      'contact.updated',
      'contact.score_changed',
      'contact.tag_removed',
      'contact.tag_applied',
      'note.added',
      'task.created',
      'task.completed',
      'opportunity.created',
      'opportunity.stage_changed',
      'opportunity.won',
      'opportunity.updated',
      'appointment.created',
      'appointment.cancelled',
      'contact.deleted',
      'contact.restored',
    ]);
    for (const e of events) expect(CRM_EVENT_TYPES).toContain(e.type);
    expect(events[3]?.payload).toEqual({
      contactId: contact.id,
      changedFields: ['family_name', 'score_value'],
    });
    expect(events[4]?.payload).toEqual({ contactId: contact.id, from: 0, to: 50 });
    expect(events[7]?.payload).toEqual({
      noteId: note.id,
      contactId: contact.id,
      companyId: null,
      opportunityId: null,
    });
    expect(events[11]?.payload).toMatchObject({
      opportunityId: opp.id,
      toStageId: won.id,
      fromStageId: opp.stage_id,
    });
    expect(events[13]?.payload).toMatchObject({ changedFields: ['value_minor'] });

    const actors = t.db.all<{ actor_type: string; actor_id: string }>(
      `SELECT DISTINCT actor_type, actor_id FROM crm_outbox`,
    );
    expect(actors).toEqual([{ actor_type: 'user', actor_id: USER_ACTOR.id }]);
  });

  it('rolls events back with a failed mutation (same transaction)', () => {
    const t = createTestTenant();
    t.op('customFields.create', {
      entity: 'contact',
      data: { key: 'age', label: 'Age', type: 'WHOLE_NUMBER' },
    });
    const vip = t.op('tags.create', { name: 'VIP' });
    expect(() => t.op('contacts.create', { given_name: 'Bad', tag_ids: [vip.id, 'nope'] })).toThrow(
      /tags not found/,
    );
    expect(() =>
      t.op('contacts.create', { given_name: 'Bad', custom_fields: { age: 'x' } }),
    ).toThrow(/whole number/);
    expect(outbox(t)).toEqual([]);
    expect(t.db.all(`SELECT id FROM crm_contacts`)).toEqual([]);
  });

  it('serves pending events and acks them (at-least-once)', () => {
    const t = createTestTenant();
    t.op('contacts.create', { given_name: 'A' });
    t.op('contacts.create', { given_name: 'B' });
    const pending = t.op('events.pending', { limit: 10 });
    expect(pending.map((e) => e.type)).toEqual(['contact.created', 'contact.created']);
    expect(pending[0]?.actor).toEqual({ type: 'user', id: 'user_1' });
    // Not acked yet: delivered again.
    expect(t.op('events.pending', { limit: 10 })).toHaveLength(2);
    t.op('events.ack', { ids: pending.map((e) => e.id) });
    expect(t.op('events.pending', { limit: 10 })).toEqual([]);
  });

  it('serves and acks more than 100 events within the 100-parameter statement limit', () => {
    const t = createTestTenant();
    for (let i = 0; i < 250; i += 1) t.op('contacts.create', { given_name: `C${String(i)}` });
    // Durable Object SQLite rejects statements with more than 100 bound parameters.
    const all = t.db.all.bind(t.db);
    const run = t.db.run.bind(t.db);
    const guard = (params: readonly unknown[]): void => {
      if (params.length > 100) throw new Error(`too many SQL variables: ${String(params.length)}`);
    };
    t.db.all = <T extends object>(query: string, ...params: SqlValue[]): T[] => {
      guard(params);
      return all<T>(query, ...params);
    };
    t.db.run = (query: string, ...params: SqlValue[]): void => {
      guard(params);
      run(query, ...params);
    };

    const pending = t.op('events.pending', { limit: 1000 });
    expect(pending).toHaveLength(250);
    const attempts = t.db.all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM crm_outbox WHERE attempts = 1`,
    );
    expect(attempts[0]?.n).toBe(250);
    expect(t.op('events.ack', { ids: pending.map((e) => e.id) })).toEqual({ acked: 250 });
    expect(t.op('events.pending', { limit: 1000 })).toEqual([]);
  });

  it('writes the activity timeline for contacts, companies and opportunities', () => {
    const t = createTestTenant();
    const company = t.op('companies.create', { name: 'Acme' });
    const contact = t.op('contacts.create', { given_name: 'Ada', company_id: company.id });
    t.op('notes.create', {
      contact_id: contact.id,
      company_id: company.id,
      title: 'Hello',
      body: doc('first note'),
    });
    const timeline = t.op('timeline', { subject: 'contact', id: contact.id, limit: 1 });
    expect(timeline.data.map((a) => a.type)).toEqual(['note.added']);
    expect(timeline.data[0]?.data).toMatchObject({ title: 'Hello', excerpt: 'first note' });
    const next = t.op('timeline', {
      subject: 'contact',
      id: contact.id,
      limit: 5,
      cursor: timeline.next_cursor ?? '',
    });
    expect(next.data.map((a) => a.type)).toEqual(['contact.created']);
    expect(
      t.op('timeline', { subject: 'company', id: company.id, limit: 10 }).data.map((a) => a.type),
    ).toEqual(['note.added', 'company.created']);
  });
});

describe('contact merge', () => {
  it('folds sources into the target and moves related records', () => {
    const t = createTestTenant();
    t.op('customFields.create', {
      entity: 'contact',
      data: { key: 'plan', label: 'Plan', type: 'TEXT' },
    });
    t.op('customFields.create', {
      entity: 'contact',
      data: { key: 'city', label: 'City', type: 'TEXT' },
    });
    const a = t.op('tags.create', { name: 'A' });
    const b = t.op('tags.create', { name: 'B' });
    const target = t.op('contacts.create', {
      given_name: 'Ada',
      emails: [{ email: 'ada@example.com' }],
      tag_ids: [a.id],
      custom_fields: { plan: 'pro' },
      score_value: 10,
    });
    const source = t.op('contacts.create', {
      given_name: 'Ada',
      family_name: 'Lovelace',
      job_title: 'Analyst',
      emails: [{ email: 'ADA@example.com' }, { email: 'ada@work.example.com' }],
      phones: [{ number: '+39 333 1234567' }],
      addresses: [{ locality: 'London', country_code: 'GB' }],
      tag_ids: [a.id, b.id],
      custom_fields: { plan: 'free', city: 'London' },
      score_value: 30,
    });
    const note = t.op('notes.create', { contact_id: source.id, body: doc('moved note') });
    const task = t.op('tasks.create', { title: 'moved task', contact_id: source.id });
    t.op('events.ack', { ids: t.op('events.pending', { limit: 100 }).map((e) => e.id) });

    const merged = t.op('contacts.merge', { targetId: target.id, sourceIds: [source.id] });
    expect(merged.family_name).toBe('Lovelace');
    expect(merged.job_title).toBe('Analyst');
    expect(merged.score_value).toBe(30);
    expect(merged.emails.map((e) => e.email)).toEqual(['ada@example.com', 'ada@work.example.com']);
    expect(merged.phones.map((p) => p.number)).toEqual(['+39 333 1234567']);
    expect(merged.addresses[0]?.locality).toBe('London');
    expect(merged.tag_ids.sort()).toEqual([a.id, b.id].sort());
    expect(merged.custom_fields).toEqual({ plan: 'pro', city: 'London' });

    expect(t.op('notes.get', { id: note.id }).contact_id).toBe(target.id);
    expect(t.op('tasks.get', { id: task.id }).contact_id).toBe(target.id);
    const gone = t.op('contacts.get', { id: source.id, includeDeleted: true });
    expect(gone.deleted_at).not.toBeNull();
    expect(gone.merged_into_id).toBe(target.id);
    expect(() => t.op('contacts.restore', { id: source.id })).toThrow(/merged/);
    expect(
      t.op('search.query', { entity: 'contact', q: 'lovelace', columns: ['id'] }).data,
    ).toEqual([{ id: target.id }]);

    const types = t.op('events.pending', { limit: 100 }).map((e) => e.type);
    expect(types).toEqual([
      'contact.updated',
      'contact.score_changed',
      'contact.tag_applied',
      'contact.merged',
    ]);
    expect(() => t.op('contacts.merge', { targetId: target.id, sourceIds: [target.id] })).toThrow(
      /itself/,
    );
  });
});
