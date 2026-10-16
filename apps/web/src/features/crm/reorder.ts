/** Moves one item and rewrites the positions of every sibling whose index changed. */
export async function reorder<T extends { id: string; position: number }>(
  items: readonly T[],
  index: number,
  delta: -1 | 1,
  save: (item: T, position: number) => Promise<unknown>,
): Promise<void> {
  const target = index + delta;
  if (target < 0 || target >= items.length) return;
  const next = [...items];
  const [moved] = next.splice(index, 1);
  if (moved === undefined) return;
  next.splice(target, 0, moved);
  for (const [position, item] of next.entries()) {
    if (item.position !== position) await save(item, position);
  }
}
