/**
 * Pure market statistics. No I/O, no clock. All inputs are arrays of numbers
 * ordered oldest → newest; results are rounded for reproducible hashes.
 */
import type { Bar } from "./types.js";
import { round } from "./util.js";

export const TRADING_DAYS = 252;

export function simpleReturns(prices: number[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < prices.length; i++) r.push(prices[i]! / prices[i - 1]! - 1);
  return r;
}

export function mean(x: number[]): number {
  return x.reduce((s, v) => s + v, 0) / x.length;
}

export function stdev(x: number[]): number | null {
  if (x.length < 2) return null;
  const m = mean(x);
  return Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1));
}

export function periodReturn(prices: number[], days: number): number | null {
  if (prices.length <= days) return null;
  return round(prices[prices.length - 1]! / prices[prices.length - 1 - days]! - 1);
}

export function annualizedVol(prices: number[], window = TRADING_DAYS): number | null {
  const r = simpleReturns(prices.slice(-(window + 1)));
  const s = stdev(r);
  return r.length >= 30 && s !== null ? round(s * Math.sqrt(TRADING_DAYS)) : null;
}

/** Largest peak-to-trough decline over the window, as a positive fraction. */
export function maxDrawdown(prices: number[], window = TRADING_DAYS): number | null {
  const p = prices.slice(-window);
  if (p.length < 30) return null;
  let peak = p[0]!;
  let worst = 0;
  for (const x of p) {
    peak = Math.max(peak, x);
    worst = Math.max(worst, 1 - x / peak);
  }
  return round(worst);
}

export function sma(prices: number[], n: number): number | null {
  if (prices.length < n) return null;
  return round(mean(prices.slice(-n)), 6);
}

/** Dates must be aligned by the caller (see alignBars). */
export function beta(asset: number[], market: number[]): number | null {
  const n = Math.min(asset.length, market.length);
  if (n < 60) return null;
  const a = asset.slice(-n);
  const m = market.slice(-n);
  const ma = mean(a);
  const mm = mean(m);
  let cov = 0;
  let varM = 0;
  for (let i = 0; i < n; i++) {
    cov += (a[i]! - ma) * (m[i]! - mm);
    varM += (m[i]! - mm) ** 2;
  }
  return varM === 0 ? null : round(cov / varM);
}

export function correlation(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 60) return null;
  const x = a.slice(-n);
  const y = b.slice(-n);
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i]! - mx) * (y[i]! - my);
    sxx += (x[i]! - mx) ** 2;
    syy += (y[i]! - my) ** 2;
  }
  return sxx === 0 || syy === 0 ? null : round(sxy / Math.sqrt(sxx * syy));
}

/** Empirical percentile (linear interpolation), p in [0,1]. */
export function percentile(x: number[], p: number): number | null {
  if (x.length === 0) return null;
  const s = [...x].sort((a, b) => a - b);
  const idx = p * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return round(s[lo]! + (s[hi]! - s[lo]!) * (idx - lo));
}

/** Historical VaR as a positive loss fraction. horizon > 1 uses overlapping windows. */
export function historicalVar(prices: number[], p: number, horizon = 1, window = TRADING_DAYS * 2): number | null {
  const px = prices.slice(-(window + horizon));
  const rets: number[] = [];
  for (let i = horizon; i < px.length; i++) rets.push(px[i]! / px[i - horizon]! - 1);
  if (rets.length < 100) return null;
  const q = percentile(rets, p);
  return q === null ? null : round(Math.max(0, -q));
}

/** Worst rolling `days`-day return (a negative number). */
export function worstRolling(prices: number[], days: number, window = TRADING_DAYS * 2): number | null {
  const px = prices.slice(-(window + days));
  if (px.length <= days + 30) return null;
  let worst = Infinity;
  for (let i = days; i < px.length; i++) worst = Math.min(worst, px[i]! / px[i - days]! - 1);
  return round(worst);
}

/** Align two bar series on common dates → paired close/adj arrays. */
export function alignBars(a: Bar[], b: Bar[]): { dates: string[]; a: number[]; b: number[] } {
  const mb = new Map(b.map((x) => [x.date, x.adj]));
  const dates: string[] = [];
  const av: number[] = [];
  const bv: number[] = [];
  for (const x of a) {
    const y = mb.get(x.date);
    if (y !== undefined) {
      dates.push(x.date);
      av.push(x.adj);
      bv.push(y);
    }
  }
  return { dates, a: av, b: bv };
}

export function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);
}
