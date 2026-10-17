/**
 * Deterministic metrics (FR-03, FR-06). Every number the report shows is
 * produced here from the market snapshot and the dossier — never by a model.
 * Each metric records formula, inputs, period, methodology and warnings;
 * missing inputs yield MISSING/INVALID, never an imputed value.
 */
import {
  TRADING_DAYS, alignBars, annualizedVol, beta, correlation, historicalVar, maxDrawdown, mean, periodReturn,
  simpleReturns, sma, worstRolling,
} from "./stats.js";
import { type Dossier, type MarketSnapshot, type MetricResult, UNIVERSE } from "./types.js";
import { METHODOLOGY_VERSION, round } from "./util.js";

type Group = MetricResult["group"];
type Unit = MetricResult["unit"];

function mk(
  id: string, group: Group, label: string, formula: string, inputs: Record<string, number | string | null>,
  value: number | null, unit: Unit, period: string | null, opts: { warnings?: string[]; missing?: string; invalid?: string } = {},
): MetricResult {
  const warnings = [...(opts.warnings ?? [])];
  let status: MetricResult["status"] = "OK";
  if (opts.invalid) {
    status = "INVALID";
    warnings.push(opts.invalid);
  } else if (value === null || !Number.isFinite(value)) {
    status = "MISSING";
    warnings.push(`MISSING_INPUT: ${opts.missing ?? "insufficient data"}`);
    value = null;
  }
  return {
    id, group, label, formula, inputs, currency: unit === "currency" ? "USD" : null, period, methodology_version: METHODOLOGY_VERSION,
    value: status === "OK" ? (value === null ? null : round(value)) : null, unit, status, warnings, evidence_class: "CALCULATED",
  };
}

export interface MetricsResult {
  metrics: MetricResult[];
  byId: Record<string, MetricResult>;
}

export const val = (byId: Record<string, MetricResult>, id: string): number | null => {
  const m = byId[id];
  return m && m.status === "OK" && m.value !== null ? m.value : null;
};

export function computeMetrics(d: Dossier, s: MarketSnapshot): MetricsResult {
  const out: MetricResult[] = [];
  const f = s.facts;
  const u = UNIVERSE[d.underlying];
  const adj = f.bars.map((b) => b.adj);
  const close = f.bars.map((b) => b.close);
  const last = close.length ? close[close.length - 1]! : null;
  const period = f.bars.length ? `${f.bars[0]!.date}→${f.bars[f.bars.length - 1]!.date} (${f.bars.length} daily bars)` : null;
  const need = (n: number) => (adj.length >= n ? undefined : `needs ≥ ${n} daily bars; have ${adj.length}`);

  // ── underlying: price-based ──────────────────────────────────────────────
  out.push(mk("price_last", "underlying_price", "Last close", "last daily close (Yahoo Finance)", { bars: adj.length }, last, "currency", period, { missing: "no price history" }));
  for (const [id, n, label] of [["ret_1m", 21, "1-month return"], ["ret_3m", 63, "3-month return"], ["ret_6m", 126, "6-month return"], ["ret_12m", 252, "12-month return"]] as const) {
    out.push(mk(id, "underlying_price", label, `adj_close[t] / adj_close[t−${n}] − 1 (dividend-adjusted)`, { window_days: n }, periodReturn(adj, n), "ratio", period, { missing: need(n + 1) }));
  }
  const vol = annualizedVol(adj);
  out.push(mk("volatility_1y", "underlying_price", "Annualised volatility (1y)", "stdev(daily returns, 252d) × √252", { window_days: 252 }, vol, "ratio", period, { missing: need(60) }));
  const mdd = maxDrawdown(adj);
  out.push(mk("max_drawdown_1y", "underlying_price", "Maximum drawdown (1y)", "max over t of (1 − adj_close[t] / running peak), 252d", { window_days: 252 }, mdd, "ratio", period, { missing: need(60) }));
  const w = adj.slice(-252);
  const hi = w.length ? Math.max(...w) : null;
  const lo = w.length ? Math.min(...w) : null;
  const lastAdj = adj.length ? adj[adj.length - 1]! : null;
  out.push(mk("drawdown_from_high", "underlying_price", "Drawdown from 52-week high", "1 − last / max(adj_close, 252d)", { last: lastAdj, high: hi }, lastAdj !== null && hi ? 1 - lastAdj / hi : null, "ratio", period, { missing: need(60) }));
  const c252 = close.slice(-252);
  const h52 = c252.length ? Math.max(...c252) : null;
  const l52 = c252.length ? Math.min(...c252) : null;
  out.push(mk("high_52w", "underlying_price", "52-week high (close)", "max(close, 252d)", {}, h52, "currency", period, { missing: need(60) }));
  out.push(mk("low_52w", "underlying_price", "52-week low (close)", "min(close, 252d)", {}, l52, "currency", period, { missing: need(60) }));
  out.push(mk("range_position_52w", "underlying_price", "Position in 52-week range", "(last − low) / (high − low)", { last, low: l52, high: h52 }, last !== null && h52 !== null && l52 !== null && h52 > l52 ? (last - l52) / (h52 - l52) : null, "ratio", period, { missing: need(60) }));
  const s50 = sma(close, 50);
  const s200 = sma(close, 200);
  out.push(mk("sma_50", "underlying_price", "50-day average close", "mean(close, 50d)", {}, s50, "currency", period, { missing: need(50) }));
  out.push(mk("sma_200", "underlying_price", "200-day average close", "mean(close, 200d)", {}, s200, "currency", period, { missing: need(200) }));
  out.push(mk("price_vs_sma200", "underlying_price", "Price vs 200-day average", "last / sma_200 − 1", { last, sma_200: s200 }, last !== null && s200 ? last / s200 - 1 : null, "ratio", period, { missing: need(200) }));

  // market-relative
  const al = alignBars(f.bars, f.spy_bars);
  const ra = simpleReturns(al.a.slice(-253));
  const rm = simpleReturns(al.b.slice(-253));
  const warnB = d.underlying === "SPY" ? ["Benchmark is the asset itself (beta = 1 by construction)."] : [];
  out.push(mk("beta_spy_1y", "underlying_price", "Beta vs SPY (1y)", "cov(r_asset, r_SPY) / var(r_SPY), aligned daily returns", { observations: ra.length }, f.spy_bars.length ? beta(ra, rm) : null, "x", period, { missing: f.spy_bars.length ? "needs ≥ 60 aligned daily returns" : "no SPY benchmark data", warnings: warnB }));
  out.push(mk("corr_spy_1y", "underlying_price", "Correlation with SPY (1y)", "corr(r_asset, r_SPY)", { observations: ra.length }, f.spy_bars.length ? correlation(ra, rm) : null, "ratio", period, { missing: f.spy_bars.length ? "needs ≥ 60 aligned daily returns" : "no SPY benchmark data" }));
  out.push(mk("var95_1d", "underlying_price", "Historical 1-day VaR (95%)", "−5th percentile of daily returns (≤2y); historical, not a forecast", {}, historicalVar(adj, 0.05, 1), "ratio", period, { missing: "needs ≥ 100 observations" }));
  out.push(mk("var95_10d", "underlying_price", "Historical 10-day VaR (95%)", "−5th percentile of overlapping 10-day returns (≤2y)", {}, historicalVar(adj, 0.05, 10), "ratio", period, { missing: "needs ≥ 100 observations", warnings: ["Overlapping windows: observations are not independent."] }));
  out.push(mk("worst_20d", "underlying_price", "Worst 20-day return (≤2y)", "min over t of adj_close[t] / adj_close[t−20] − 1", {}, worstRolling(adj, 20), "ratio", period, { missing: "insufficient history" }));
  const rf = s.metrics.find((m) => m.key === "rate_3m");
  const rets = simpleReturns(adj.slice(-253));
  const annRet = rets.length >= 60 ? mean(rets) * TRADING_DAYS : null;
  out.push(mk("sharpe_1y", "underlying_price", "Sharpe ratio (1y, vs 3-month Treasury)", "(mean daily return × 252 − risk-free) / annualised volatility", { risk_free_pct: rf?.value ?? null, annualised_return: annRet === null ? null : round(annRet) }, annRet !== null && vol && rf ? (annRet - rf.value / 100) / vol : null, "x", period, { missing: rf ? "insufficient history" : "no risk-free rate" }));
  const dv = f.bars.slice(-63);
  out.push(mk("avg_dollar_volume_3m", "underlying_price", "Average daily dollar volume (3m)", "mean(close × volume, 63d)", { days: dv.length }, dv.length >= 20 ? mean(dv.map((b) => b.close * b.volume)) : null, "currency", period, { missing: "needs ≥ 20 days of volume" }));
  const div = s.metrics.find((m) => m.key === "dividend_ttm");
  out.push(mk("dividend_yield_ttm", "underlying_price", "Dividend yield (12m)", "dividends per share (12m) / last close", { dividend_ttm: div?.value ?? null, last }, div && last ? div.value / last : null, "ratio", period, { missing: "no dividends recorded in the last 12 months (or no price)" }));

  // ── underlying: fundamentals (SEC) ───────────────────────────────────────
  const fund = f.fundamentals?.items ?? {};
  const g = (k: string) => fund[k]?.value ?? null;
  const fper = (k: string) => (fund[k] ? `${fund[k]!.basis} to ${fund[k]!.period_end}` : null);
  const noFund = u.kind === "etf" ? "ETFs file no company financial statements" : "SEC facts unavailable or tag not reported";
  const fm = (id: string, label: string, formula: string, inputs: Record<string, number | null>, v: number | null, unit: Unit, per: string | null, extra: { warnings?: string[]; invalid?: string; missing?: string } = {}) =>
    out.push(mk(id, "underlying_fundamentals", label, formula, inputs, v, unit, per, { missing: noFund, ...extra }));
  const rev = g("revenue");
  const ni = g("net_income");
  const opi = g("operating_income");
  const ocf = g("ocf");
  const cap = g("capex");
  const eps = g("eps_diluted");
  const sh = g("shares_outstanding");
  fm("revenue_ttm", "Revenue (TTM)", "FY + YTD − prior-year YTD (SEC 10-K/10-Q)", { revenue: rev }, rev, "currency", fper("revenue"));
  fm("net_income_ttm", "Net income (TTM)", "FY + YTD − prior-year YTD (SEC)", { net_income: ni }, ni, "currency", fper("net_income"));
  fm("operating_income_ttm", "Operating income (TTM)", "FY + YTD − prior-year YTD (SEC)", { operating_income: opi }, opi, "currency", fper("operating_income"));
  fm("ocf_ttm", "Operating cash flow (TTM)", "FY + YTD − prior-year YTD (SEC)", { ocf }, ocf, "currency", fper("ocf"));
  fm("capex_ttm", "Capital expenditure (TTM)", "payments to acquire PP&E (SEC)", { capex: cap }, cap, "currency", fper("capex"), { warnings: ["Excludes leases and acquisitions."] });
  const fcf = ocf !== null && cap !== null ? ocf - Math.abs(cap) : null;
  fm("fcf_ttm", "Free cash flow (TTM)", "operating cash flow − |capex|", { ocf, capex: cap }, fcf, "currency", fper("ocf"));
  fm("eps_ttm", "Diluted EPS (TTM)", "sum of diluted EPS over four quarters (SEC)", { eps }, eps, "currency", fper("eps_diluted"));
  const mcap = last !== null && sh !== null ? last * sh : null;
  fm("market_cap", "Market capitalisation", "last close × shares outstanding (cover page)", { last, shares: sh }, mcap, "currency", fper("shares_outstanding"), {
    warnings: ["Dual-class issuers: all reported share classes are valued at this ticker's price."],
  });
  fm("pe_ttm", "P/E (TTM)", "last close / diluted EPS (TTM)", { last, eps }, last !== null && eps !== null && eps > 0 ? last / eps : null, "x", fper("eps_diluted"), eps !== null && eps <= 0 ? { invalid: "NON_POSITIVE_EPS: P/E is not meaningful" } : {});
  fm("ps_ttm", "Price / sales (TTM)", "market cap / revenue (TTM)", { market_cap: mcap, revenue: rev }, mcap !== null && rev ? mcap / rev : null, "x", fper("revenue"));
  fm("net_margin", "Net margin (TTM)", "net income / revenue", { net_income: ni, revenue: rev }, ni !== null && rev ? ni / rev : null, "ratio", fper("revenue"));
  fm("operating_margin", "Operating margin (TTM)", "operating income / revenue", { operating_income: opi, revenue: rev }, opi !== null && rev ? opi / rev : null, "ratio", fper("revenue"));
  fm("fcf_margin", "Free-cash-flow margin (TTM)", "FCF / revenue", { fcf, revenue: rev }, fcf !== null && rev ? fcf / rev : null, "ratio", fper("revenue"));
  fm("fcf_yield", "Free-cash-flow yield", "FCF (TTM) / market cap", { fcf, market_cap: mcap }, fcf !== null && mcap ? fcf / mcap : null, "ratio", fper("revenue"));
  const r0 = g("revenue_fy");
  const r1 = g("revenue_fy_prior");
  fm("revenue_growth_fy", "Revenue growth (latest FY vs prior FY)", "revenue FY / revenue prior FY − 1", { fy: r0, prior_fy: r1 }, r0 !== null && r1 ? r0 / r1 - 1 : null, "ratio", fund.revenue_fy ? `FY ending ${fund.revenue_fy.period_end}` : null);
  const debt = g("debt");
  const cash = g("cash");
  const nd = debt !== null && cash !== null ? debt - cash : null;
  fm("net_debt", "Net debt (long-term debt − cash & equivalents)", "long-term debt − cash and cash equivalents (latest filing)", { debt, cash }, nd, "currency", fper("debt"), { warnings: ["Excludes marketable securities and lease liabilities; indicative only."] });
  fm("net_debt_to_fcf", "Net debt / FCF", "net debt / FCF (TTM)", { net_debt: nd, fcf }, nd !== null && fcf !== null && fcf > 0 ? Math.max(0, nd) / fcf : null, "x", fper("ocf"));

  // ── token wrapper (on-chain) ─────────────────────────────────────────────
  const t = f.token;
  const tok = d.token;
  const noTok = tok ? "token facts unavailable (RPC unreachable or contract not readable)" : "no token contract supplied";
  const tm = (id: string, label: string, formula: string, inputs: Record<string, number | string | null>, v: number | null, unit: Unit, per: string | null, extra: { warnings?: string[]; invalid?: string; missing?: string } = {}) =>
    out.push(mk(id, "token", label, formula, inputs, v, unit, per, { missing: noTok, ...extra }));
  const blockPer = t ? `block ${t.block_number}` : null;
  const supply = t?.total_supply ?? null;
  const tps = tok?.tokens_per_share ?? null;
  tm("token_total_supply", "Token total supply (on-chain)", "totalSupply() / 10^decimals", { decimals: t?.decimals ?? null }, supply, "count", blockPer);
  const shares = supply !== null && tps ? supply / tps : null;
  tm("token_underlying_shares_implied", "Underlying shares implied by supply", "total supply / tokens_per_share", { supply, tokens_per_share: tps }, shares, "count", blockPer);
  tm("token_notional_usd", "Value of the underlying shares the supply represents", "implied shares × last close", { shares, last }, shares !== null && last !== null ? shares * last : null, "currency", blockPer, { warnings: ["Uses the last daily close, which may lag the current price."] });
  const nav = last !== null && tps ? last / tps : null;
  tm("token_nav_per_token", "Reference value per token", "last close / tokens_per_share", { last, tokens_per_share: tps }, nav, "currency", period, { missing: tok ? "no underlying price" : "no token contract supplied" });
  const feed = t?.feed ?? null;
  tm("token_feed_price", "On-chain price feed (token/USD)", "latestRoundData().answer / 10^feedDecimals", { feed: feed?.address ?? null }, feed?.answer ?? null, "currency", feed ? `round ${feed.round_id}` : null, { missing: tok?.price_feed ? "feed could not be read" : "no price_feed supplied; token market price not assessed" });
  tm("token_premium_discount", "Token premium (+) / discount (−) to reference value", "feed price / (last close / tokens_per_share) − 1", { feed: feed?.answer ?? null, nav }, feed && nav ? feed.answer / nav - 1 : null, "ratio", blockPer, { missing: tok?.price_feed ? "feed or underlying price unavailable" : "no price_feed supplied; token market price not assessed" });
  tm("token_feed_age_days", "Age of the on-chain price update", "(latest block time − feed updatedAt) / 86400", { updated_at: feed?.updated_at ?? null, block_time: t?.block_time ?? null }, feed && t ? (t.block_time - feed.updated_at) / 86_400 : null, "days", blockPer, { missing: "no feed data" });
  const rs = t?.redemption_signals ?? null;
  tm("redemption_entrypoints", "On-chain redemption entry points (burn / burnFrom / redeem found in bytecode)", "count of burn(uint256), burnFrom(address,uint256), redeem selectors present in the token and its implementation bytecode", { burn: rs ? Number(rs.burn) : null, burn_from: rs ? Number(rs.burn_from) : null, redeem: rs ? Number(rs.redeem) : null, mint: rs ? Number(rs.mint) : null }, rs ? Number(rs.burn) + Number(rs.burn_from) + Number(rs.redeem) : null, "count", blockPer, { warnings: ["A capability signal only: it shows the contract can burn/redeem, not that the issuer honours redemptions."] });
  const claimed = d.claims?.shares_held_in_custody;
  tm("backing_ratio", "Claimed custody vs implied shares", "shares_held_in_custody (issuer claim) / shares implied by on-chain supply", { claimed_shares: claimed ?? null, implied_shares: shares }, claimed !== undefined && shares ? claimed / shares : null, "ratio", blockPer, { missing: claimed === undefined ? "issuer did not state shares held in custody" : noTok, warnings: ["Numerator is an issuer claim, not a verified reserve."] });
  if (d.position) {
    tm("position_value_usd", "Position value at reference price", "tokens × reference value per token", { tokens: d.position.tokens, nav }, nav !== null ? d.position.tokens * nav : null, "currency", period);
    if (d.position.cost_basis_usd !== undefined) {
      tm("position_pnl_usd", "Position profit/loss vs cost basis", "position value − cost basis", { cost_basis: d.position.cost_basis_usd }, nav !== null ? d.position.tokens * nav - d.position.cost_basis_usd : null, "currency", period);
    }
  }

  const byId: Record<string, MetricResult> = {};
  for (const m of out) byId[m.id] = m;
  return { metrics: out, byId };
}
