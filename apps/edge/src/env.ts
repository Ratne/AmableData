import type { AnalyticsDO } from './analytics/do';
import type { AnalyticsMessage } from './analytics/types';
import type { RegistryMessage } from './analytics/registry';

/** Bindings of the edge worker — mirror of wrangler.jsonc. */
export interface Env {
  /** "dev" locally; production deployments never set it. */
  ENVIRONMENT?: string;
  /** One AnalyticsDO per site (`site:<id>`) plus one site index per tenant (`tenant:<id>`). */
  ANALYTICS: DurableObjectNamespace<AnalyticsDO>;
  /** Enriched events → AnalyticsDO batches. Without it, ingest writes to the DO directly. */
  ANALYTICS_QUEUE?: Queue<AnalyticsMessage>;
  /** Optional extra shards (`analytics-1..3`): sites are spread over the bound queues by hash. */
  ANALYTICS_QUEUE_1?: Queue<AnalyticsMessage>;
  ANALYTICS_QUEUE_2?: Queue<AnalyticsMessage>;
  ANALYTICS_QUEUE_3?: Queue<AnalyticsMessage>;
  /** Realtime/high-volume counters. Optional: absent bindings fall back to an in-memory counter. */
  AE?: AnalyticsEngineDataset;
  /** Analytics WAL / cold archive (`events/`, `wal-pending/`, `corrections/`, see analytics/wal.ts). */
  FILES?: R2Bucket;
  /** Contact data of the events, consumed by the core (workspace registry). */
  REGISTRY_QUEUE?: Queue<RegistryMessage>;

  /** Service binding to the core worker (default fetch): signed `/_edge/*` gateway calls. */
  CORE?: Fetcher;
  /** HMAC secret shared with the core worker (Wrangler secret on both). Dev falls back to a public constant. */
  EDGE_GATEWAY_SECRET?: string;
}
