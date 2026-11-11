import { z } from 'zod';

/**
 * Operations page of a workspace: what is stuck or behind (parked registry
 * messages, tracking segments waiting for replay, backups), with the recovery
 * actions.
 */

const ts = z.number().int();

export const opsStatusSchema = z.object({
  registry: z.object({
    /** Registry messages parked after their retries (replayable). */
    parked: z.number().int(),
    truncated: z.boolean(),
    oldest_at: ts.nullable(),
  }),
  sites: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      last_event_at: ts.nullable(),
      /** Tracking segments waiting to be applied (replayed by the edge every 5 minutes). */
      pending_segments: z.number().int(),
      /** Segments the site no longer recognizes: checked by hand (runbook). */
      stale_segments: z.number().int(),
      /** Events the site could not apply. */
      poison_objects: z.number().int(),
    }),
  ),
  backups: z.object({ count: z.number().int(), last_at: z.string().nullable() }),
});
export type OpsStatus = z.infer<typeof opsStatusSchema>;

export const opsReplaySchema = z.object({
  replayed: z.number().int(),
  /** Messages that failed again: they stay parked. */
  failed: z.number().int(),
  remaining: z.boolean(),
});
export type OpsReplay = z.infer<typeof opsReplaySchema>;
