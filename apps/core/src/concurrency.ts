/**
 * Runs `task` over `items` with at most `limit` calls in flight; results keep
 * the input order. A rejected task rejects the whole call, so tasks that must
 * not stop the others catch their own errors.
 */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}
