/**
 * Point-in-time recovery of the tenant Durable Objects (SQLite storage keeps 30 days
 * of history). Arming stores the bookmark for `atMs`; the storage is replaced the
 * next time the object starts, so the caller then restarts it with `pointInTimeApply`.
 */
export interface PointInTimeStub {
  pointInTimeArm(atMs: number): Promise<string>;
  pointInTimeApply(): Promise<void>;
}

export async function armPointInTime(storage: DurableObjectStorage, atMs: number): Promise<string> {
  const bookmark = await storage.getBookmarkForTime(atMs);
  await storage.onNextSessionRestoreBookmark(bookmark);
  return bookmark;
}
