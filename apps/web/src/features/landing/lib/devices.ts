import type { Breakpoint } from '@amable/builder';

/**
 * Simulated devices: the preview iframe is laid out at the real viewport width
 * so media queries match, and each device maps to its own breakpoint
 * (≤1366 laptop, ≤1024 tablet, ≤767 mobile, ≤389 small mobile).
 */
export const DEVICES = [
  { key: 'desktop', width: 1440 },
  { key: 'laptop', width: 1280 },
  { key: 'tablet', width: 810 },
  { key: 'mobile', width: 390 },
  { key: 'mobilesm', width: 375 },
] as const;

export type DeviceKey = (typeof DEVICES)[number]['key'];

export function breakpointForWidth(width: number): Breakpoint {
  if (width <= 389) return 'mobilesm';
  if (width <= 767) return 'mobile';
  if (width <= 1024) return 'tablet';
  if (width <= 1366) return 'laptop';
  return 'desktop';
}

export type CanvasZoom = 'fit' | number;

export const ZOOMS: readonly { key: string; value: CanvasZoom }[] = [
  { key: 'fit', value: 'fit' },
  { key: '50', value: 0.5 },
  { key: '75', value: 0.75 },
  { key: '100', value: 1 },
];
