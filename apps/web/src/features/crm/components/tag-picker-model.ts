/** Pure selection logic of the tag picker (kept apart from React for tests). */

export const TAG_PAGE_SIZE = 25;
export const TAG_SEARCH_DEBOUNCE_MS = 200;
/** `GET /tags?ids=` accepts at most this many ids per call. */
export const TAG_IDS_PER_CALL = 100;

/** Picks or un-picks `id`: multi toggles (respecting `max`), single replaces. */
export function toggleTag(
  value: readonly string[],
  id: string,
  options: { multiple: boolean; max?: number },
): string[] {
  if (!options.multiple) return value[0] === id ? [] : [id];
  if (value.includes(id)) return value.filter((v) => v !== id);
  if (options.max !== undefined && value.length >= options.max) return [...value];
  return [...value, id];
}

/** "Create «q»" is offered when the query is a usable name nobody has yet (case-insensitive). */
export function shouldOfferCreate(query: string, names: readonly string[]): boolean {
  const name = query.trim();
  if (name === '' || name.length > 100) return false;
  const lower = name.toLocaleLowerCase();
  return !names.some((existing) => existing.toLocaleLowerCase() === lower);
}

/** Splits ids for `GET /tags?ids=` (dedup, stable order). */
export function idBatches(ids: readonly string[], size = TAG_IDS_PER_CALL): string[][] {
  const unique = [...new Set(ids)];
  const out: string[][] = [];
  for (let i = 0; i < unique.length; i += size) out.push(unique.slice(i, i + size));
  return out;
}
