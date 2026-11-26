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

/**
 * Anonymous usage statistics of the installation (docs/telemetry.md).
 * `control`: `local` (the owner decides here), `portal` (linked installation:
 * decided in the AmableData portal), `env_off` (`TELEMETRY=off` in the deployment).
 */
export const opsTelemetrySchema = z.object({
  enabled: z.boolean(),
  control: z.enum(['local', 'portal', 'env_off']),
  /** Only workspace owners change it, and only when `control` is `local`. */
  can_change: z.boolean(),
  last_sent_at: ts.nullable(),
  /** The exact body of the next daily ping. */
  preview: z.record(z.string(), z.unknown()),
});
export type OpsTelemetry = z.infer<typeof opsTelemetrySchema>;

export const opsTelemetryUpdateSchema = z.strictObject({ enabled: z.boolean() });
export type OpsTelemetryUpdate = z.infer<typeof opsTelemetryUpdateSchema>;
