import type { Shortlink, ShortlinkUtmField } from '@amable/api-types';

/** Destination with the UTM of the form (what the redirect sends, before pass-through params). */
export function composePreview(url: string, utm: Partial<Record<ShortlinkUtmField, string>>): string {
  try {
    const dest = new URL(url);
    for (const [k, v] of Object.entries(utm)) {
      if (v !== undefined && v.trim() !== '') dest.searchParams.set(k, v.trim());
    }
    return dest.toString();
  } catch {
    return url;
  }
}

export function isExpired(link: Pick<Shortlink, 'expires_at'>, now: number = Date.now()): boolean {
  return link.expires_at !== null && Date.parse(link.expires_at) <= now;
}

/** ISO → value of an `<input type="datetime-local">` (local time). */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Value of an `<input type="datetime-local">` (local time) → ISO, `null` when empty or invalid. */
export function fromLocalInput(value: string): string | null {
  if (value.trim() === '') return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Short URL without the scheme, for display. */
export function displayShortUrl(link: Pick<Shortlink, 'short_url' | 'key'>): string {
  return link.short_url === null ? `…/${link.key}` : link.short_url.replace(/^https?:\/\//, '');
}
