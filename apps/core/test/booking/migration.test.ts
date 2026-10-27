import { tenantMigrations } from '@amable/db';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

function migratedUpTo(id: number): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const migration of tenantMigrations.filter((m) => m.id <= id)) {
    for (const statement of migration.statements) db.exec(statement);
  }
  return db;
}

function insertEventType(db: DatabaseSync, id: string, reminders: string, messages: string): void {
  db.prepare(
    `INSERT INTO booking_event_types (id, slug, title, duration_minutes, reminder_minutes, messages, created_at, updated_at)
     VALUES (?, ?, 'T', 30, ?, ?, 0, 0)`,
  ).run(id, id, reminders, messages);
}

describe('tenant migration 20 (booking policies)', () => {
  it('turns the reminder offsets and the shared reminder text into before notifications', () => {
    const db = migratedUpTo(19);
    insertEventType(db, 'custom', '[60, 1440, 15, 2880, 30]', JSON.stringify({ reminder_subject: 'Soon', reminder_body: 'See you', confirmation_subject: 'Ok' }));
    insertEventType(db, 'plain', '[1440]', '{}');
    insertEventType(db, 'none', '[]', '{}');
    const migration = tenantMigrations.find((m) => m.id === 20);
    for (const statement of migration?.statements ?? []) db.exec(statement);

    const rows = db.prepare(`SELECT id, notifications, allow_reschedule, allow_cancel, reminder_minutes FROM booking_event_types ORDER BY id`).all() as Array<{
      id: string;
      notifications: string;
      allow_reschedule: number;
      allow_cancel: number;
      reminder_minutes: string;
    }>;
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(JSON.parse(byId.get('custom')?.notifications ?? '')).toEqual([
      { when: 'before', offset_minutes: 2880, subject: 'Soon', body: 'See you' },
      { when: 'before', offset_minutes: 1440, subject: 'Soon', body: 'See you' },
      { when: 'before', offset_minutes: 60, subject: 'Soon', body: 'See you' },
    ]);
    expect(JSON.parse(byId.get('plain')?.notifications ?? '')).toEqual([{ when: 'before', offset_minutes: 1440, subject: '', body: '' }]);
    expect(JSON.parse(byId.get('none')?.notifications ?? '')).toEqual([]);
    expect(rows.every((r) => r.allow_reschedule === 1 && r.allow_cancel === 1)).toBe(true);
    expect(byId.get('custom')?.reminder_minutes).toBe('[60, 1440, 15, 2880, 30]');
  });
});
