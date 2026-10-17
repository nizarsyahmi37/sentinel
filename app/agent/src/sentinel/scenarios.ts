/**
 * Scenario and sensitivity analysis (FR-08, PRD §8.6).
 *
 * Underlying shocks, token-wrapper shocks and their combinations. Every
 * scenario states what changes and what is held constant, is reproducible,
 * recomputed through the same arithmetic as the base case, and is labelled
 * hypothetical — never a forecast. Each driver is applied once per scenario.
 */
import type { MetricsResult } from "./metrics.js";
import { val } from "./metrics.js";
import type { Dossier, ScenarioConfig } from "./types.js";
import { round } from "./util.js";

export interface ScenarioChange {
  variable: string;
  from: number | null;
  to: number | null;
  unit: string;
}

export interface MetricComparison {
  base: number | null;
  scenario: number | null;
  delta: number | null;
}

export interface ScenarioResult {
  scenario_id: string;
  level: 1 | 2 | 3;
  label: string;
  kind: "hypothetical";
  status: "computed" | "not_computable";
  reason?: string;
  changes: ScenarioChange[];
  held_constant: string[];
  assumptions: string[];
  metrics: Record<string, number | null>;
  comparison: Record<string, MetricComparison>;
}

export const DEFAULT_SCENARIO_CONFIG = {
  market_shock_pct: [10, 20],
  token_discount_pct: [5, 10],
  multiple_compression_pct: 20,
  eps_shock_pct: 20,
};

const TRACKED = ["underlying_price", "underlying_change", "token_value_per_token", "position_value_usd", "position_change_usd", "implied_pe"] as const;
const DRIVERS = ["underlying_price", "eps_ttm", "pe_multiple", "token_discount_to_reference", "tokens_per_share", "position_size"];

interface Ctx {
  price: number;
  tps: number | null;
  tokens: number | null;
  costBasis: number | null;
  eps: number | null;
  pe: number | null;
  beta: number | null;
  vol: number | null;
  worst20: number | null;
  mdd: number | null;
  hasToken: boolean;
}

function evaluate(c: Ctx, priceFactor: number, discount: number, pe?: number | null): Record<string, number | null> {
  const price = c.price * priceFactor;
  const tv = c.tps ? (price / c.tps) * (1 - discount) : null;
  const pos = tv !== null && c.tokens !== null ? tv * c.tokens : null;
  const basePos = c.tps && c.tokens !== null ? (c.price / c.tps) * c.tokens : null;
  return {
    underlying_price: round(price, 4),
    underlying_change: round(price / c.price - 1),
    token_value_per_token: tv === null ? null : round(tv, 6),
    position_value_usd: pos === null ? null : round(pos, 2),
    position_change_usd: pos !== null && basePos !== null ? round(pos - basePos, 2) : null,
    implied_pe: pe === undefined ? (c.pe !== null ? round(c.pe * priceFactor, 4) : null) : pe === null ? null : round(pe, 4),
  };
}

export function runScenarios(d: Dossier, m: MetricsResult, config?: ScenarioConfig): ScenarioResult[] {
  const cfg = { ...DEFAULT_SCENARIO_CONFIG, ...(d.scenario_config ?? {}), ...(config ?? {}) };
  const price = val(m.byId, "price_last");
  const tps = d.token?.tokens_per_share ?? null;
  const base: Ctx | null =
    price === null
      ? null
      : {
          price, tps, tokens: d.position?.tokens ?? null, costBasis: d.position?.cost_basis_usd ?? null, eps: val(m.byId, "eps_ttm"), pe: val(m.byId, "pe_ttm"),
          beta: val(m.byId, "beta_spy_1y"), vol: val(m.byId, "volatility_1y"), worst20: val(m.byId, "worst_20d"), mdd: val(m.byId, "max_drawdown_1y"), hasToken: !!d.token,
        };
  const baseVals = base ? evaluate(base, 1, 0) : null;

  const out: ScenarioResult[] = [];
  const add = (
    id: string, level: 1 | 2 | 3, label: string, build: (c: Ctx) => { factor: number; discount: number; pe?: number | null; changes: ScenarioChange[]; touched: string[]; assumptions: string[] } | string,
  ) => {
    const fail = (reason: string) => out.push({ scenario_id: id, level, label, kind: "hypothetical", status: "not_computable", reason, changes: [], held_constant: DRIVERS, assumptions: [], metrics: {}, comparison: {} });
    if (!base || !baseVals) return fail("no underlying price available");
    const r = build(base);
    if (typeof r === "string") return fail(r);
    const metrics = evaluate(base, r.factor, r.discount, r.pe);
    const comparison: Record<string, MetricComparison> = {};
    for (const k of TRACKED) {
      const b = baseVals[k] ?? null;
      const s = metrics[k] ?? null;
      comparison[k] = { base: b, scenario: s, delta: b !== null && s !== null ? round(s - b, 6) : null };
    }
    out.push({
      scenario_id: id, level, label, kind: "hypothetical", status: "computed", changes: r.changes,
      held_constant: DRIVERS.filter((x) => !r.touched.includes(x)),
      assumptions: [...r.assumptions, "Hypothetical stress, not a forecast. Variables not listed under 'changes' stay at their base values."],
      metrics, comparison,
    });
  };

  const priceChange = (c: Ctx, factor: number): ScenarioChange => ({ variable: "underlying_price", from: round(c.price, 4), to: round(c.price * factor, 4), unit: "USD" });
  const discChange = (disc: number): ScenarioChange => ({ variable: "token_discount_to_reference", from: 0, to: disc, unit: "ratio" });
  const marketFactor = (c: Ctx, x: number): number | string => (c.beta === null ? "beta vs SPY unavailable" : Math.max(0, 1 - c.beta * (x / 100)));

  for (const x of cfg.market_shock_pct) {
    add(`market_down_${x}`, 2, `Broad market −${x}% (beta-implied)`, (c) => {
      const f = marketFactor(c, x);
      if (typeof f === "string") return f;
      return { factor: f, discount: 0, changes: [priceChange(c, f)], touched: ["underlying_price"], assumptions: [`SPY falls ${x}% and this asset moves by its 1-year beta (${c.beta}) times that, linearly. Beta is unstable and idiosyncratic moves are ignored.`] };
    });
  }
  add("vol_1sigma_1m", 1, "One-sigma monthly decline (volatility-implied)", (c) => {
    if (c.vol === null) return "volatility unavailable";
    const f = 1 - c.vol / Math.sqrt(12);
    return { factor: f, discount: 0, changes: [priceChange(c, f)], touched: ["underlying_price"], assumptions: [`A one-standard-deviation monthly move using annualised volatility ${c.vol} ÷ √12. Assumes normal returns; real tails are fatter.`] };
  });
  add("vol_2sigma_1m", 1, "Two-sigma monthly decline (volatility-implied)", (c) => {
    if (c.vol === null) return "volatility unavailable";
    const f = Math.max(0, 1 - (2 * c.vol) / Math.sqrt(12));
    return { factor: f, discount: 0, changes: [priceChange(c, f)], touched: ["underlying_price"], assumptions: [`A two-standard-deviation monthly move using annualised volatility ${c.vol} ÷ √12.`] };
  });
  add("worst_20d_replay", 1, "Replay of the worst 20-day return in the last 2 years", (c) => {
    if (c.worst20 === null) return "insufficient history";
    const f = 1 + c.worst20;
    return { factor: f, discount: 0, changes: [priceChange(c, f)], touched: ["underlying_price"], assumptions: [`The asset's own worst rolling 20-day return (${c.worst20}) recurs from today's price.`] };
  });
  add("drawdown_replay", 1, "Repeat of the 1-year maximum drawdown", (c) => {
    if (c.mdd === null) return "insufficient history";
    const f = 1 - c.mdd;
    return { factor: f, discount: 0, changes: [priceChange(c, f)], touched: ["underlying_price"], assumptions: [`A further decline equal to the worst peak-to-trough fall of the last year (${c.mdd}).`] };
  });
  add("multiple_derating", 1, `P/E multiple de-rates ${cfg.multiple_compression_pct}% (EPS unchanged)`, (c) => {
    if (c.pe === null || c.eps === null) return "needs positive trailing EPS (SEC fundamentals)";
    const f = 1 - cfg.multiple_compression_pct / 100;
    return { factor: f, discount: 0, pe: c.pe * f, changes: [{ variable: "pe_multiple", from: round(c.pe, 4), to: round(c.pe * f, 4), unit: "x" }, priceChange(c, f)], touched: ["pe_multiple", "underlying_price"], assumptions: [`The market pays ${cfg.multiple_compression_pct}% less per dollar of trailing earnings; EPS stays ${c.eps}.`] };
  });
  add("eps_and_multiple", 3, `EPS −${cfg.eps_shock_pct}% and multiple −${cfg.multiple_compression_pct / 2}%`, (c) => {
    if (c.pe === null || c.eps === null) return "needs positive trailing EPS (SEC fundamentals)";
    const mf = 1 - cfg.multiple_compression_pct / 200;
    const ef = 1 - cfg.eps_shock_pct / 100;
    const f = mf * ef;
    return { factor: f, discount: 0, pe: c.pe * mf, changes: [{ variable: "eps_ttm", from: c.eps, to: round(c.eps * ef, 4), unit: "USD/share" }, { variable: "pe_multiple", from: round(c.pe, 4), to: round(c.pe * mf, 4), unit: "x" }, priceChange(c, f)], touched: ["eps_ttm", "pe_multiple", "underlying_price"], assumptions: ["Earnings disappoint and the multiple contracts together; each driver applied once."] };
  });
  for (const x of cfg.token_discount_pct) {
    add(`token_discount_${x}`, 2, `Token trades ${x}% below reference value (depeg / redemption friction)`, (c) => {
      if (!c.hasToken || c.tps === null) return "no token contract supplied";
      return { factor: 1, discount: x / 100, changes: [discChange(x / 100)], touched: ["token_discount_to_reference"], assumptions: [`The token's market price falls ${x}% below its reference value (underlying price ÷ tokens per share) while the underlying is unchanged — e.g. redemption halted, thin liquidity or oracle lag.`] };
    });
  }
  const mk = cfg.market_shock_pct[cfg.market_shock_pct.length - 1] ?? 20;
  const td = cfg.token_discount_pct[cfg.token_discount_pct.length - 1] ?? 10;
  add("combined_market_discount", 3, `Market −${mk}% and token ${td}% below reference`, (c) => {
    if (!c.hasToken || c.tps === null) return "no token contract supplied";
    const f = marketFactor(c, mk);
    if (typeof f === "string") return f;
    return { factor: f, discount: td / 100, changes: [priceChange(c, f), discChange(td / 100)], touched: ["underlying_price", "token_discount_to_reference"], assumptions: [`A ${mk}% market fall (beta-implied) together with a ${td}% token discount. The two are applied once each; their correlation is not modelled.`] };
  });
  return out;
}
