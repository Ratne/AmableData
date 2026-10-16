/**
 * Integer money math. Every amount is minor units (cents); rates are basis
 * points. Products are computed with BigInt so `amount × rate` never loses
 * precision, then rounded half up (away from zero for positive values).
 */

/** round(a × b / d), half up, for non-negative integers. */
export function mulDivRound(a: number, b: number, d: number): number {
  if (d <= 0) throw new RangeError('divisor must be positive');
  const n = BigInt(a) * BigInt(b);
  const D = BigInt(d);
  return Number((n * 2n + D) / (2n * D));
}

/** Tax on a (net) amount at `rateBps`, rounded half up. */
export function taxOf(amountMinor: number, rateBps: number): number {
  return mulDivRound(amountMinor, rateBps, 10_000);
}

/**
 * Splits `total` across `weights` proportionally, exactly (largest remainder):
 * the shares always sum to `total`; ties go to the earliest line.
 */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (total === 0 || sum === 0) return weights.map(() => 0);
  const T = BigInt(total);
  const S = BigInt(sum);
  const shares = weights.map((w) => {
    const exact = T * BigInt(w);
    return { floor: Number(exact / S), remainder: exact % S };
  });
  let left = total - shares.reduce((a, s) => a + s.floor, 0);
  const order = shares
    .map((s, i) => ({ i, remainder: s.remainder }))
    .sort((x, y) => (x.remainder === y.remainder ? x.i - y.i : x.remainder > y.remainder ? -1 : 1));
  const result = shares.map((s) => s.floor);
  for (const { i } of order) {
    if (left <= 0) break;
    result[i] = (result[i] ?? 0) + 1;
    left -= 1;
  }
  return result;
}

export interface LineInput {
  quantity: number;
  unitPriceMinor: number;
  taxRateBps: number;
  /** Whether the order discount applies to this line. */
  discountable: boolean;
}

export interface DiscountRule {
  kind: 'percent' | 'fixed';
  percentBps: number | null;
  amountMinor: number | null;
}

export interface LineTotals {
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
}

export interface OrderTotals {
  lines: LineTotals[];
  subtotalMinor: number;
  /** Eligible subtotal the discount was computed on. */
  eligibleMinor: number;
  discountMinor: number;
  taxMinor: number;
  shippingMinor: number;
  totalMinor: number;
}

/**
 * Order totals:
 * - line subtotal = quantity × unit price;
 * - discount: percent of the eligible subtotal (rounded half up) or a fixed
 *   amount capped at the eligible subtotal, allocated to eligible lines in
 *   proportion to their subtotal (largest remainder, so shares sum exactly);
 * - line tax = (line subtotal − line discount) × rate, rounded half up per line;
 * - total = subtotal − discount + tax + shipping (shipping is neither taxed nor discounted).
 */
export function computeTotals(
  lines: LineInput[],
  discount: DiscountRule | null,
  shippingMinor: number,
): OrderTotals {
  const subtotals = lines.map((l) => l.quantity * l.unitPriceMinor);
  const eligible = subtotals.map((s, i) => (lines[i]?.discountable === true ? s : 0));
  const eligibleMinor = eligible.reduce((a, b) => a + b, 0);
  let discountMinor = 0;
  if (discount !== null && eligibleMinor > 0) {
    discountMinor =
      discount.kind === 'percent'
        ? mulDivRound(eligibleMinor, discount.percentBps ?? 0, 10_000)
        : Math.min(discount.amountMinor ?? 0, eligibleMinor);
  }
  const shares = allocate(discountMinor, eligible);
  const lineTotals = lines.map((line, i) => {
    const subtotalMinor = subtotals[i] ?? 0;
    const discountShare = shares[i] ?? 0;
    const taxMinor = taxOf(subtotalMinor - discountShare, line.taxRateBps);
    return {
      subtotalMinor,
      discountMinor: discountShare,
      taxMinor,
      totalMinor: subtotalMinor - discountShare + taxMinor,
    };
  });
  const subtotalMinor = subtotals.reduce((a, b) => a + b, 0);
  const taxMinor = lineTotals.reduce((a, l) => a + l.taxMinor, 0);
  return {
    lines: lineTotals,
    subtotalMinor,
    eligibleMinor,
    discountMinor,
    taxMinor,
    shippingMinor,
    totalMinor: subtotalMinor - discountMinor + taxMinor + shippingMinor,
  };
}

const DAY_MS = 86_400_000;

/** Adds `count` billing intervals to an epoch-ms instant (UTC calendar math, end-of-month clamped). */
export function addInterval(
  ms: number,
  interval: 'day' | 'week' | 'month' | 'year',
  count: number,
): number {
  if (interval === 'day') return ms + count * DAY_MS;
  if (interval === 'week') return ms + count * 7 * DAY_MS;
  const date = new Date(ms);
  const months = interval === 'month' ? count : count * 12;
  const day = date.getUTCDate();
  const target = new Date(ms);
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.getTime();
}

/** Approximate length of a billing period in days (to compare plans across intervals). */
export function periodDays(interval: 'day' | 'week' | 'month' | 'year', count: number): number {
  const base =
    interval === 'day' ? 1 : interval === 'week' ? 7 : interval === 'month' ? 30.4375 : 365.25;
  return base * count;
}
