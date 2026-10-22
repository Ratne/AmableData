import { z } from 'zod';

/**
 * Exclusive edit lock shared by landing pages, automations, broadcasts, email
 * templates and forms: one person edits, the others watch read-only.
 */

export const editLockHolderSchema = z.object({
  user_id: z.string(),
  user_name: z.string(),
  /** Epoch ms the holder acquired the lock. */
  since: z.number().int(),
});
export type EditLockHolder = z.infer<typeof editLockHolderSchema>;

/**
 * Lock state, pushed on the `GET /<resources>/{id}/lock` WebSocket (`type: 'state'`)
 * and returned by `GET /<resources>/{id}/lock/status`. `role` is the caller's.
 * Client → server messages: `{type:'heartbeat'}` every 10 s, `{type:'release'}`,
 * `{type:'takeover'}` (requires the resource's takeover permission).
 */
export const editLockStateSchema = z.object({
  type: z.literal('state'),
  holder: editLockHolderSchema.nullable(),
  role: z.enum(['holder', 'waiting']),
  waiting: z.number().int(),
});
export type EditLockState = z.infer<typeof editLockStateSchema>;

export const editLockClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('heartbeat') }),
  z.object({ type: z.literal('release') }),
  z.object({ type: z.literal('takeover') }),
]);
export type EditLockClientMessage = z.infer<typeof editLockClientMessageSchema>;
