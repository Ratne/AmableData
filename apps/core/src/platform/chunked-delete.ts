/** Rows per DELETE statement: each one stays far below the D1 30 s query cap. */
export const DELETE_CHUNK = 5000;

/**
 * Deletes the rows of `table` matching `where` in rowid chunks, up to `maxRounds`
 * statements (the next run continues). `where` should be backed by an index.
 */
export async function deleteInChunks(
  db: D1Database,
  table: string,
  where: string,
  binds: readonly unknown[],
  options: { chunk?: number; maxRounds?: number } = {},
): Promise<number> {
  const chunk = options.chunk ?? DELETE_CHUNK;
  const maxRounds = options.maxRounds ?? 20;
  let deleted = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    const result = await db
      .prepare(
        `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ${String(chunk)})`,
      )
      .bind(...binds)
      .run();
    const changes = result.meta.changes ?? 0;
    deleted += changes;
    if (changes < chunk) break;
  }
  return deleted;
}
