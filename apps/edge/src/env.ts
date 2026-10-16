import type { AnalyticsDO } from './analytics/do';
import type { AnalyticsMessage } from './analytics/types';

/** Bindings of the edge worker — mirror of wrangler.jsonc. */
export interface Env {
  /** "dev" locally; production deployments never set it. */
  ENVIRONMENT?: string;
  /** One AnalyticsDO per site (`site:<id>`) plus one site index per tenant (`tenant:<id>`). */
  ANALYTICS: DurableObjectNamespace<AnalyticsDO>;
  /** Enriched events → AnalyticsDO batches. Without it, ingest writes to the DO directly. */
  ANALYTICS_QUEUE?: Queue<AnalyticsMessage>;
  /** Realtime/high-volume counters. Optional: absent bindings fall back to an in-memory counter. */
  AE?: AnalyticsEngineDataset;
  /** Raw analytics archive (`analytics-archive/` prefix) before retention purges. */
  FILES?: R2Bucket;

  // --- Hosted forms, booking pages, landing SSR (apps/edge/src/{forms,booking,pages}) ---
  /** Service binding to the core worker (default fetch): signed `/_edge/*` gateway calls. */
  CORE?: Fetcher;
  /** HMAC secret shared with the core worker (Wrangler secret on both). Dev falls back to a public constant. */
  EDGE_GATEWAY_SECRET?: string;
}
