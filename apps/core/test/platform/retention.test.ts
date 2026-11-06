import { beforeEach, describe, expect, it } from 'vitest';
import { runRetention } from '../../src/platform/retention';
import { createHarness, seedUser, type Harness } from '../helpers/harness';

const DAY = 24 * 3600 * 1000;

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

async function count(table: string): Promise<number> {
  const row = await h.env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

describe('installation retention', () => {
  it('drops expired sessions and auth rows after the grace week, keeps live ones', async () => {
    const user = await seedUser(h, { email: 'u@acme.test' });
    const now = h.clock.now;
    const session = (id: string, expiresAt: number) =>
      h.env.DB.prepare(
        `INSERT INTO sessions (id, public_id, user_id, created_at, last_seen_at, expires_at, absolute_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, `p_${id}`, user.id, now - 30 * DAY, now - 30 * DAY, expiresAt, expiresAt);
    await session('s_old', now - 8 * DAY).run();
    await session('s_grace', now - DAY).run();
    await session('s_live', now + DAY).run();
    await h.env.DB.prepare(
      `INSERT INTO auth_tokens (id, purpose, user_id, created_at, expires_at, used_at)
       VALUES ('t_old', 'reset', ?, ?, ?, NULL), ('t_live', 'reset', ?, ?, ?, NULL)`,
    )
      .bind(user.id, now - 9 * DAY, now - 8 * DAY, user.id, now, now + DAY)
      .run();

    await runRetention(h.env, now);
    expect(await count('sessions')).toBe(2); // s_grace (inside the week) and s_live
    expect(await count('auth_tokens')).toBe(1);
  });

  it('drops reported usage meters older than the window, keeps unreported and recent ones', async () => {
    const now = h.clock.now;
    const usage = (tenant: string, hourStart: number, reportedAt: number | null) =>
      h.env.DB.prepare(
        `INSERT INTO platform_usage (tenant_id, channel, hour_start, count, reported_at) VALUES (?, 'email', ?, 1, ?)`,
      ).bind(tenant, hourStart, reportedAt);
    await usage('t1', now - 100 * DAY, now - 99 * DAY).run(); // old and reported: dropped
    await usage('t2', now - 100 * DAY, null).run(); // old but never reported: kept
    await usage('t3', now - DAY, now).run(); // recent: kept

    expect(await runRetention(h.env, now)).toBe(1);
    expect(await count('platform_usage')).toBe(2);
  });

  it('drops audit rows older than a year, keeps newer ones', async () => {
    const now = h.clock.now;
    const audit = (id: string, createdAt: number) =>
      h.env.DB.prepare(`INSERT INTO audit_log (id, action, created_at) VALUES (?, 'x', ?)`).bind(
        id,
        createdAt,
      );
    await audit('a_old', now - 366 * DAY).run();
    await audit('a_new', now - 300 * DAY).run();
    expect(await runRetention(h.env, now)).toBe(1);
    expect(await count('audit_log')).toBe(1);
  });
});
