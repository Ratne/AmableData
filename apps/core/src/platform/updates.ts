import type { Env } from '../env';

/**
 * "New version available" for self-hosted installations: once a day the cron asks
 * GitHub for the latest public release and stores it in `installation_meta`; owners
 * see a banner when it is newer than `APP_VERSION`. Managed installations are
 * updated by the control plane, which deploys them with `UPDATE_CHECK=off`.
 */

export const RELEASES_API_URL = 'https://api.github.com/repos/Ratne/AmableData/releases/latest';
const RELEASES_PAGE_PREFIX = 'https://github.com/Ratne/AmableData/releases/';
export const UPDATE_CHECK_KEY = 'update_check';
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface StoredUpdateCheck {
  readonly latest: string | null;
  readonly url: string | null;
  readonly checkedAt: number;
}

export interface UpdateNotice {
  readonly current: string;
  readonly latest: string;
  readonly url: string;
}

type Version = readonly [number, number, number];

/** `2026.10.1`, `v2026.10.1` or `2026.10.1-3-gabc1234` (git describe) → [2026, 10, 1]. */
export function parseVersion(value: string | undefined | null): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:$|[-+])/.exec(value?.trim() ?? '');
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (a === null || b === null) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return (a[i] as number) > (b[i] as number);
  }
  return false;
}

export function updateChecksEnabled(env: Env): boolean {
  return env.UPDATE_CHECK?.trim().toLowerCase() !== 'off' && parseVersion(env.APP_VERSION) !== null;
}

async function readStored(db: D1Database): Promise<StoredUpdateCheck | null> {
  const row = await db
    .prepare(`SELECT value FROM installation_meta WHERE key = ?`)
    .bind(UPDATE_CHECK_KEY)
    .first<{ value: string }>();
  if (row === null) return null;
  try {
    const parsed = JSON.parse(row.value) as Partial<StoredUpdateCheck>;
    return {
      latest: typeof parsed.latest === 'string' ? parsed.latest : null,
      url: typeof parsed.url === 'string' ? parsed.url : null,
      checkedAt: typeof parsed.checkedAt === 'number' ? parsed.checkedAt : 0,
    };
  } catch {
    return null;
  }
}

async function writeStored(db: D1Database, value: StoredUpdateCheck): Promise<void> {
  await db
    .prepare(
      `INSERT INTO installation_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(UPDATE_CHECK_KEY, JSON.stringify(value))
    .run();
}

/** Cron step: at most one GitHub request a day; failures keep the previous answer. */
export async function runUpdateCheck(
  env: Env,
  nowMs: number,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): Promise<void> {
  if (!updateChecksEnabled(env)) return;
  const stored = await readStored(env.DB);
  if (stored !== null && nowMs - stored.checkedAt < UPDATE_CHECK_INTERVAL_MS) return;
  let latest = stored?.latest ?? null;
  let url = stored?.url ?? null;
  try {
    const response = await fetcher(RELEASES_API_URL, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'amable-update-check' },
    });
    if (response.ok) {
      const body = (await response.json()) as { tag_name?: unknown; html_url?: unknown };
      if (typeof body.tag_name === 'string' && parseVersion(body.tag_name) !== null) {
        latest = body.tag_name.replace(/^v/, '');
        url =
          typeof body.html_url === 'string' && body.html_url.startsWith(RELEASES_PAGE_PREFIX)
            ? body.html_url
            : `${RELEASES_PAGE_PREFIX}tag/${encodeURIComponent(body.tag_name)}`;
      }
    } else {
      console.warn(`[updates] release check answered ${String(response.status)}`);
    }
  } catch (error) {
    console.warn('[updates] release check failed', error instanceof Error ? error.message : error);
  }
  await writeStored(env.DB, { latest, url, checkedAt: nowMs });
}

export async function updateNotice(env: Env): Promise<UpdateNotice | null> {
  if (!updateChecksEnabled(env)) return null;
  const current = (env.APP_VERSION ?? '').trim();
  const stored = await readStored(env.DB);
  if (stored === null || stored.latest === null || stored.url === null) return null;
  if (!isNewer(stored.latest, current)) return null;
  return { current, latest: stored.latest, url: stored.url };
}
