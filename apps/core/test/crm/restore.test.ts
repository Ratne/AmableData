import { describe, expect, it } from 'vitest';
import { createTestTenant } from './helpers';

describe('undo of deletes', () => {
  it('restores deleted tasks and opportunities', () => {
    const t = createTestTenant();
    const contact = t.op('contacts.create', { given_name: 'Ada' });
    const task = t.op('tasks.create', { title: 'Call back', contact_id: contact.id });
    t.op('tasks.delete', { id: task.id });
    expect(() => t.op('tasks.get', { id: task.id })).toThrow(/not found/);
    expect(t.op('tasks.restore', { id: task.id })).toMatchObject({
      id: task.id,
      title: 'Call back',
    });
    expect(t.op('tasks.get', { id: task.id }).id).toBe(task.id);

    t.op('pipelines.create', { name: 'Sales' });
    const deal = t.op('opportunities.create', { title: 'Deal', contact_id: contact.id });
    t.op('opportunities.delete', { id: deal.id });
    expect(() => t.op('opportunities.get', { id: deal.id })).toThrow(/not found/);
    expect(t.op('opportunities.restore', { id: deal.id })).toMatchObject({
      id: deal.id,
      title: 'Deal',
    });
    expect(() => t.op('opportunities.restore', { id: 'missing' })).toThrow(/not found/);
  });

  it('refuses to restore a deal whose pipeline was deleted meanwhile', () => {
    const t = createTestTenant();
    t.op('pipelines.create', { name: 'Sales' });
    const other = t.op('pipelines.create', { name: 'Partners' });
    const deal = t.op('opportunities.create', { title: 'Deal', pipeline_id: other.id });
    t.op('opportunities.delete', { id: deal.id });
    t.op('pipelines.delete', { id: other.id });
    expect(() => t.op('opportunities.restore', { id: deal.id })).toThrow(/no longer exists/);
  });
});
