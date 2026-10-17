/**
 * Portfolio view (PRD Phase 4): concentration, correlation and stress across
 * holdings drawn from the supported universe, computed from the same real
 * price history. Constant-weight, historical, not a forecast.
 */
import { type LookThrough, fetchEtfHoldings } from "./holdings.js";
import { buildMarketSnapshot } from "./market.js";
import type { FetchLike } from "./sources.js";
import { TRADING_DAYS, beta, correlation, mean, simpleReturns, stdev } from "./stats.js";
import { type Bar, DossierSchema, SYMBOLS, type Symbol, UNIVERSE } from "./types.js";
import { round } from "./util.js";

export interface Holding {
  symbol: Symbol;
  value_usd: number;
}

export interface PortfolioAnalysis {
  status: "ok" | "unavailable";
  reason: string | null;
  total_value_usd: number;
  holdings: { symbol: Symbol; kind: "stock" | "etf"; value_usd: number; weight: number; vol_1y: number | null; beta_spy: number | null; ret_12m: number | null }[];
  concentration: { hhi: number | null; effective_positions: number | null; largest: { symbol: Symbol; weight: number } | null; flags: string[] };
  correlation: { symbols: Symbol[]; matrix: (number | null)[][]; average_pairwise: number | null; highest: { a: Symbol; b: Symbol; value: number } | null };
  risk: { observations: number; period: string | null; volatility_1y: number | null; sum_of_standalone_vol: number | null; diversification_ratio: number | null; max_drawdown_1y: number | null; worst_20d: number | null; portfolio_beta: number | null; return_12m: number | null };
  look_through: { etf: string; status: "ok" | "unavailable"; as_of: string | null; reason: string | null }[];
  effective_exposure: { ticker: string; name: string; direct: number; via_etf: number; total: number }[];
  stress: { scenario: string; portfolio_change: number | null; value_change_usd: number | null; basis: string }[];
  notes: string[];
}

export function parseHoldings(input: { symbol: string; value_usd: number }[]): { ok: true; holdings: Holding[] } | { ok: false; error: string } {
  const merged = new Map<Symbol, number>();
  for (const h of input) {
    const sym = String(h.symbol).toUpperCase() as Symbol;
    if (!SYMBOLS.includes(sym)) return { ok: false, error: `"${h.symbol}" is not in the supported universe (${SYMBOLS.join(", ")}).` };
    if (!Number.isFinite(h.value_usd) || h.value_usd <= 0) return { ok: false, error: `value_usd for ${sym} must be a positive number.` };
    merged.set(sym, (merged.get(sym) ?? 0) + h.value_usd);
  }
  if (merged.size < 1) return { ok: false, error: "Provide at least one holding." };
  return { ok: true, holdings: [...merged].map(([symbol, value_usd]) => ({ symbol, value_usd })) };
}

export async function fetchHoldingBars(holdings: Holding[], o: { now: Date; fetchImpl?: FetchLike; cacheDir?: string; offline?: boolean }): Promise<{ bars: Partial<Record<Symbol, Bar[]>>; spy: Bar[]; failed: { symbol: Symbol; error: string }[] }> {
  const bars: Partial<Record<Symbol, Bar[]>> = {};
  const failed: { symbol: Symbol; error: string }[] = [];
  let spy: Bar[] = [];
  await Promise.all(holdings.map(async (h) => {
    try {
      const snap = await buildMarketSnapshot(DossierSchema.parse({ underlying: h.symbol }), { ...o, allowSimulation: false });
      if (!snap.facts.bars.length) throw new Error("price history unavailable");
      bars[h.symbol] = snap.facts.bars;
      if (snap.facts.spy_bars.length > spy.length) spy = snap.facts.spy_bars;
    } catch (e) {
      failed.push({ symbol: h.symbol, error: e instanceof Error ? e.message : String(e) });
    }
  }));
  if (!spy.length && bars.SPY) spy = bars.SPY;
  return { bars, spy, failed };
}

const mx = (a: number[]) => Math.max(...a);

export interface EtfData {
  etf: string;
  status: "ok" | "unavailable";
  as_of: string | null;
  reason: string | null;
  holdings: { ticker: string; name: string; weight: number }[];
}

export async function fetchEtfData(holdings: Holding[], f?: FetchLike): Promise<EtfData[]> {
  return Promise.all(
    holdings.filter((h) => UNIVERSE[h.symbol].kind === "etf").map(async (h): Promise<EtfData> => {
      try {
        const e = await fetchEtfHoldings(h.symbol, f);
        return { etf: h.symbol, status: "ok", as_of: e.as_of, reason: null, holdings: e.holdings };
      } catch (err) {
        return { etf: h.symbol, status: "unavailable", as_of: null, reason: err instanceof Error ? err.message : String(err), holdings: [] };
      }
    }),
  );
}

export function analyzePortfolio(holdings: Holding[], data: { bars: Partial<Record<Symbol, Bar[]>>; spy: Bar[]; failed?: { symbol: Symbol; error: string }[]; etfs?: EtfData[] }): PortfolioAnalysis {
  const notes: string[] = [
    "Constant-weight, historical analysis over the common trading dates; not a forecast and not a recommendation.",
    
  ];
  for (const f of data.failed ?? []) notes.push(`${f.symbol}: price history unavailable (${f.error}); excluded from risk statistics.`);
  const total = holdings.reduce((s, h) => s + h.value_usd, 0);
  const usable = holdings.filter((h) => data.bars[h.symbol]?.length);
  const empty = (reason: string): PortfolioAnalysis => ({
    status: "unavailable", reason, total_value_usd: round(total, 2),
    holdings: holdings.map((h) => ({ symbol: h.symbol, kind: UNIVERSE[h.symbol].kind, value_usd: h.value_usd, weight: round(h.value_usd / total), vol_1y: null, beta_spy: null, ret_12m: null })),
    concentration: { hhi: null, effective_positions: null, largest: null, flags: [] },
    correlation: { symbols: [], matrix: [], average_pairwise: null, highest: null },
    risk: { observations: 0, period: null, volatility_1y: null, sum_of_standalone_vol: null, diversification_ratio: null, max_drawdown_1y: null, worst_20d: null, portfolio_beta: null, return_12m: null },
    look_through: [], effective_exposure: [], stress: [], notes,
  });
  if (!usable.length) return empty("No price history could be retrieved for any holding.");

  // common dates
  const maps = usable.map((h) => new Map(data.bars[h.symbol]!.map((b) => [b.date, b.adj])));
  const dates = [...maps[0]!.keys()].filter((d) => maps.every((m) => m.has(d))).sort().slice(-(TRADING_DAYS + 1));
  if (dates.length < 60) return empty(`Only ${dates.length} common trading dates; need at least 60.`);
  const px = usable.map((_, i) => dates.map((d) => maps[i]!.get(d)!));
  const rets = px.map(simpleReturns);
  const usableTotal = usable.reduce((s, h) => s + h.value_usd, 0);
  const w = usable.map((h) => h.value_usd / usableTotal);
  const n = rets[0]!.length;
  const pr = Array.from({ length: n }, (_, t) => rets.reduce((s, r, i) => s + w[i]! * r[t]!, 0));
  const sd = stdev(pr)!;
  const vol = sd * Math.sqrt(TRADING_DAYS);
  const vols = rets.map((r) => stdev(r)! * Math.sqrt(TRADING_DAYS));
  const weighted = vols.reduce((s, v, i) => s + w[i]! * v, 0);

  // equity curve → drawdown / worst 20d / 12m return
  let v = 1; const curve = [1];
  for (const r of pr) curve.push((v *= 1 + r));
  let peak = 1, mdd = 0;
  for (const c of curve) { peak = Math.max(peak, c); mdd = Math.max(mdd, 1 - c / peak); }
  let worst = 0;
  for (let i = 20; i < curve.length; i++) worst = Math.min(worst, curve[i]! / curve[i - 20]! - 1);

  // beta vs SPY
  const spyMap = new Map(data.spy.map((b) => [b.date, b.adj]));
  const sd2 = dates.filter((d) => spyMap.has(d));
  const spyOk = sd2.length === dates.length;
  const spyR = spyOk ? simpleReturns(dates.map((d) => spyMap.get(d)!)) : [];
  const betas = rets.map((r) => (spyOk ? beta(r, spyR) : null));
  const pBeta = spyOk ? beta(pr, spyR) : null;

  const k = usable.length;
  const matrix: (number | null)[][] = usable.map((_, i) => usable.map((__, j) => (i === j ? 1 : ((c) => (c === null ? null : round(c)))(correlation(rets[i]!, rets[j]!)))));
  const pairs: { a: Symbol; b: Symbol; value: number }[] = [];
  for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) if (matrix[i]![j] !== null) pairs.push({ a: usable[i]!.symbol, b: usable[j]!.symbol, value: matrix[i]![j]! });
  const hhi = w.reduce((s, x) => s + x * x, 0);
  const li = w.indexOf(mx(w));
  const flags: string[] = [];
  if (mx(w) > 0.4) flags.push(`${usable[li]!.symbol} is ${(mx(w) * 100).toFixed(0)}% of the portfolio (single-name concentration above 40%).`);
  const etfW = usable.reduce((s, h, i) => s + (UNIVERSE[h.symbol].kind === "etf" ? w[i]! : 0), 0);
  const stockW = 1 - etfW;
  const avgPair = pairs.length ? mean(pairs.map((p) => p.value)) : null;
  if (avgPair !== null && avgPair > 0.7) flags.push(`Average pairwise correlation is ${avgPair.toFixed(2)}: holdings tend to move together, so diversification is limited.`);
  const hi = pairs.length ? pairs.reduce((a, b) => (b.value > a.value ? b : a)) : null;
  const pChange = (shock: number) => (pBeta === null ? null : round(pBeta * shock));
  const stress = [-0.1, -0.2].map((s) => ({ scenario: `Market (SPY) ${(s * 100).toFixed(0)}%`, portfolio_change: pChange(s), value_change_usd: pChange(s) === null ? null : round(pChange(s)! * usableTotal, 2), basis: "portfolio beta × shock; assumes a stable linear beta and ignores idiosyncratic risk" }));
  stress.push({ scenario: "Repeat of the worst 20-day window in the last year", portfolio_change: round(worst), value_change_usd: round(worst * usableTotal, 2), basis: "constant-weight portfolio history, not a forecast" });
  stress.push({ scenario: "2σ one-month move (down)", portfolio_change: round(-2 * sd * Math.sqrt(21)), value_change_usd: round(-2 * sd * Math.sqrt(21) * usableTotal, 2), basis: "daily σ × √21, normal approximation" });

  // look-through: direct stock weight + ETF weight × constituent weight (issuer files)
  const eff = new Map<string, { name: string; direct: number; via: number }>();
  const bump = (t: string, name: string, d: number, v: number) => {
    const e = eff.get(t) ?? { name, direct: 0, via: 0 };
    e.direct += d; e.via += v; if (!e.name) e.name = name; eff.set(t, e);
  };
  usable.forEach((h, i) => { if (UNIVERSE[h.symbol].kind === "stock") bump(h.symbol, UNIVERSE[h.symbol].name, w[i]!, 0); });
  const lt = (data.etfs ?? []).map((e) => ({ etf: e.etf, status: e.status, as_of: e.as_of, reason: e.reason }));
  for (const e of data.etfs ?? []) {
    const idx = usable.findIndex((h) => h.symbol === e.etf);
    if (idx < 0) continue;
    if (e.status === "ok") for (const c of e.holdings) bump(c.ticker, c.name, 0, w[idx]! * c.weight);
    else notes.push(`${e.etf}: look-through unavailable (${e.reason}); overlap with single stocks is not quantified.`);
  }
  if (!(data.etfs ?? []).length && usable.some((h) => UNIVERSE[h.symbol].kind === "etf")) notes.push("ETF look-through was not requested; overlap with single stocks is not quantified.");
  const effective = [...eff].map(([ticker, e]) => ({ ticker, name: e.name, direct: round(e.direct), via_etf: round(e.via), total: round(e.direct + e.via) })).sort((a, b) => b.total - a.total);
  const lookOk = (data.etfs ?? []).some((e) => e.status === "ok");
  if (lookOk) {
    const top = effective[0];
    if (top && top.total > 0.3 && top.via_etf > 0) flags.push(`Including look-through, ${top.ticker} is ${(top.total * 100).toFixed(1)}% of the portfolio (${(top.direct * 100).toFixed(1)}% direct + ${(top.via_etf * 100).toFixed(1)}% via ETFs).`);
    const hidden = effective.filter((x) => x.via_etf > 0 && x.direct > 0);
    if (hidden.length) flags.push(`Overlap: ${hidden.slice(0, 3).map((x) => `${x.ticker} ${(x.total * 100).toFixed(1)}% effective`).join(", ")} — single stocks you hold are also inside your ETFs.`);
  } else if (etfW > 0 && stockW > 0) flags.push(`Holds both index ETFs (${(etfW * 100).toFixed(0)}%) and single stocks that are likely constituents, but look-through is unavailable, so overlap is not quantified.`);
  return {
    status: "ok", reason: null, total_value_usd: round(total, 2),
    holdings: holdings.map((h) => {
      const i = usable.findIndex((u) => u.symbol === h.symbol);
      return { symbol: h.symbol, kind: UNIVERSE[h.symbol].kind, value_usd: h.value_usd, weight: round(h.value_usd / total), vol_1y: i < 0 ? null : round(vols[i]!), beta_spy: i < 0 ? null : betas[i] ?? null, ret_12m: i < 0 ? null : round(px[i]![px[i]!.length - 1]! / px[i]![0]! - 1) };
    }),
    concentration: { hhi: round(hhi), effective_positions: round(1 / hhi, 2), largest: { symbol: usable[li]!.symbol, weight: round(mx(w)) }, flags },
    correlation: { symbols: usable.map((h) => h.symbol), matrix, average_pairwise: avgPair === null ? null : round(avgPair), highest: hi },
    risk: { observations: n, period: `${dates[0]}→${dates[dates.length - 1]}`, volatility_1y: round(vol), sum_of_standalone_vol: round(weighted), diversification_ratio: vol > 0 ? round(weighted / vol, 3) : null, max_drawdown_1y: round(mdd), worst_20d: round(worst), portfolio_beta: pBeta, return_12m: round(curve[curve.length - 1]! - 1) },
    look_through: lt, effective_exposure: effective.slice(0, 15), stress, notes,
  };
}
