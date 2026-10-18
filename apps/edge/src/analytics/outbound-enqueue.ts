import type { TrafficSource } from '@amable/api-types';
import type { ConversionOutboundRequest, OutboundPii } from './outbound-worker';

/** The site's AnalyticsDO stub, as far as outbound conversions go. */
export interface OutboundEnqueueTarget {
  enqueueConversionOutbound(input: ConversionOutboundRequest): Promise<unknown>;
}

export interface OutboundEnqueueOptions {
  /** Ad-optimization consent of the visitor (server postbacks: the sender collected it). */
  consent?: boolean;
}

/**
 * Hands a stored conversion to the outbound queue of its traffic source
 * (platform API mapping, gates, dedup by event id live in the DO). The PII is
 * passed in memory only: it never reaches `conversion_log` or the touches.
 * Returns false when nothing was attempted (no source) or the enqueue failed;
 * failures are logged, never thrown, so the postback still succeeds.
 */
export async function enqueueConversionOutbound(
  store: OutboundEnqueueTarget,
  conversion: { id: string },
  source: Pick<TrafficSource, 'id'> | null,
  pii: OutboundPii,
  options: OutboundEnqueueOptions = {},
): Promise<boolean> {
  if (source === null) return false;
  const hasPii = Object.values(pii).some((v) => v !== null && v !== undefined && v !== '');
  try {
    const result = (await store.enqueueConversionOutbound({
      conversion_id: conversion.id,
      ...(hasPii ? { pii } : {}),
      consent: options.consent ?? true,
    })) as { ok?: boolean; error?: { code?: string } } | null;
    if (result?.ok === false) {
      console.error('[links] outbound enqueue rejected', result.error?.code ?? 'unknown');
      return false;
    }
    return true;
  } catch (error) {
    console.error('[links] outbound enqueue failed', error instanceof Error ? error.message : String(error));
    return false;
  }
}
