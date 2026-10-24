/**
 * Australian resident income tax for 2026–27 (the 16% rate falls to 15% from 1 July 2026), plus the 2%
 * Medicare levy. Simplified: no offsets, no levy thresholds, no HELP repayments. Used three ways, so they
 * always agree: the demo bank pays net salaries with it, the converter works gross income back out with it,
 * and lenders' programs estimate take-home pay with it.
 */
export const BRACKETS: [from: number, rate: number][] = [[18_200, 0.15], [45_000, 0.3], [135_000, 0.37], [190_000, 0.45]];
export const MEDICARE = 0.02;

export function incomeTax(gross: number): number {
  let tax = gross * MEDICARE;
  BRACKETS.forEach(([from, rate], i) => {
    const to = BRACKETS[i + 1]?.[0] ?? Infinity;
    tax += Math.max(0, Math.min(gross, to) - from) * rate;
  });
  return tax;
}

/** Gross yearly income from a year of net pay: the inverse of the above, by bisection. */
export function grossFromNet(net: number): number {
  let [lo, hi] = [net, net * 2 + 10_000];
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (mid - incomeTax(mid) < net) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** A number as a CEL double literal: CEL never mixes int and double, so 2 is written 2.0. */
export const dbl = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(n));

/** The same tax, as a CEL expression over a gross income (a quote program's language). */
export function taxExpr(gross: string): string {
  const parts = [`${gross} * ${dbl(MEDICARE)}`, ...BRACKETS.map(([from, rate], i) => {
    const to = BRACKETS[i + 1]?.[0];
    const top = to === undefined ? gross : `min(${gross}, ${dbl(to)})`;
    return `max(0.0, ${top} - ${dbl(from)}) * ${dbl(rate)}`;
  })];
  return `(${parts.join(' + ')})`;
}
