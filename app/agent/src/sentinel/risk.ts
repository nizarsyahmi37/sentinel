/**
 * Integrated risk register (FR-09): market, underlying-asset and token-wrapper
 * risks are kept apart. A strong market or strong fundamentals never offsets a
 * token-structure, custody or evidence concern.
 */
import type { LookThrough } from "./holdings.js";
import type { Thresholds } from "./config.js";
import type { EvidenceAssessment } from "./evidence.js";
import type { MarketAnalysis } from "./market.js";
import { val } from "./metrics.js";
import type { ScenarioResult } from "./scenarios.js";
import { type Dossier, type MarketSnapshot, type MetricResult, type Risk, type Severity, UNIVERSE } from "./types.js";
import { pct, round, shortId } from "./util.js";

export interface RiskInputs {
  dossier: Dossier;
  byId: Record<string, MetricResult>;
  market: MarketAnalysis;
  snapshot: MarketSnapshot;
  scenarios: ScenarioResult[];
  evidence: EvidenceAssessment;
  thresholds: Thresholds;
  lookthrough?: LookThrough | null;
}

const RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };
export const severityRank = (s: Severity): number => RANK[s];

export interface RiskRegisters {
  market: Risk[];
  underlying: Risk[];
  token: Risk[];
}

export function buildRisks(i: RiskInputs): RiskRegisters {
  const t = i.thresholds;
  const v = (id: string) => val(i.byId, id);
  const ev = (claim: string) => i.evidence.records.filter((r) => r.claim === claim || r.claim === `market:${claim}`).map((r) => r.evidence_id);
  const gapOf = (claim: string) => i.evidence.gaps.find((g) => g.related_claim === claim);
  const scen = (id: string) => i.scenarios.find((s) => s.scenario_id === id && s.status === "computed");
  const sym = i.dossier.underlying;
  const etf = UNIVERSE[sym].kind === "etf";

  const mk = (scope: Risk["scope"], category: string, severity: Severity, description: string, refs: string[], impact: string, confidence: Risk["confidence"], followUp: string, invalidation: string | null): Risk => ({
    risk_id: shortId("risk", { scope, category, description }), scope, category, description, severity, supporting_evidence: [...new Set(refs)],
    potential_impact: impact, confidence, suggested_follow_up: followUp, invalidation_condition: invalidation,
  });
  const market: Risk[] = [];
  const und: Risk[] = [];
  const tok: Risk[] = [];

  // ── Market ────────────────────────────────────────────────────────────────
  const beta = v("beta_spy_1y");
  const m20 = scen("market_down_20");
  if (beta !== null && sym !== "SPY") {
    const sev: Severity = beta >= t.beta_high ? "high" : beta >= t.beta_medium ? "medium" : "low";
    if (sev !== "low") market.push(mk("market", "market_sensitivity", sev, `Beta vs SPY is ${beta}${m20 ? `; a 20% market fall implies about ${pct(-(m20.metrics.underlying_change ?? 0), 1)} loss on the underlying` : ""}.`, ["beta_spy_1y", ...ev("beta_spy_1y")], "Amplified losses in broad sell-offs.", "medium", "Size the position for the stressed loss, not the average one.", `Beta rises above ${t.beta_high}.`));
  }
  const tr = i.market.attractiveness.drivers.find((d) => d.driver.startsWith("Broad-market trend"));
  if (tr?.direction === "unfavorable") market.push(mk("market", "market_regime", "medium", tr.basis, ev("spy_price"), "Downtrends often persist and widen drawdowns.", "medium", "Review the regime before adding exposure.", "SPY regains its 200-day average."));
  const curve = i.market.rates.curve_spread_pp;
  if (curve !== null && curve < 0) market.push(mk("market", "rates_and_financing", "medium", `The yield curve is inverted (10y − 3m = ${curve} pp).`, [...ev("treasury_10y"), ...ev("rate_3m")], "Inversions have historically preceded slowdowns; discount-rate pressure on valuations.", "low", "Monitor rates and earnings revisions.", "The curve normalises."));
  const y10 = i.market.rates.treasury_10y;
  const pe = v("pe_ttm");
  if (y10 !== null && pe !== null && y10 >= 4.5 && pe >= t.pe_medium) market.push(mk("market", "rates_and_financing", "medium", `A high 10-year yield (${y10}%) coincides with a high P/E (${pe}x): valuation is sensitive to discount rates.`, [...ev("treasury_10y"), "pe_ttm"], "Multiple compression if yields rise.", "medium", "Stress the multiple.", `The 10-year yield rises ≥ ${t.monitor_yield_move_pp} pp.`));
  if (i.snapshot.data_quality_status === "unavailable") market.push(mk("market", "data_availability", "high", "No market data could be retrieved; market risk is not assessed.", [], "The assessment lacks market context.", "low", "Retry when the sources are reachable.", null));
  else if (i.snapshot.metrics.some((m) => m.freshness === "stale")) market.push(mk("market", "data_availability", "low", `Some inputs are stale: ${i.snapshot.metrics.filter((m) => m.freshness === "stale").map((m) => m.key).join(", ")}.`, [], "Stale inputs may misstate current conditions.", "medium", "Refresh before relying on the report.", null));
  if (i.snapshot.sources.some((s) => s.source_id.startsWith("yahoo_"))) market.push(mk("market", "data_availability", "low", "Prices come from an unofficial Yahoo Finance endpoint (delayed, no SLA); it is not a licensed market-data feed.", [], "Quotes may be delayed or change without notice.", "medium", "Use a licensed feed before commercial reliance.", null));

  // ── Underlying ────────────────────────────────────────────────────────────
  const vol = v("volatility_1y");
  if (vol !== null) {
    const sev: Severity = vol >= t.vol_high ? "high" : vol >= t.vol_medium ? "medium" : "low";
    if (sev !== "low") und.push(mk("underlying", "volatility", sev, `Annualised 1-year volatility is ${pct(vol, 1)}.`, ["volatility_1y", ...ev("volatility_1y")], "Large price swings in either direction.", "high", "Reflect volatility in position size.", `Volatility exceeds ${pct(t.vol_high, 0)}.`));
  }
  const mdd = v("max_drawdown_1y");
  if (mdd !== null) {
    const sev: Severity = mdd >= t.drawdown_high ? "high" : mdd >= t.drawdown_medium ? "medium" : "low";
    if (sev !== "low") und.push(mk("underlying", "drawdown", sev, `The worst peak-to-trough fall in the last year was ${pct(mdd, 1)}.`, ["max_drawdown_1y"], "Demonstrated capacity for deep losses.", "high", "Stress the position against this drawdown.", "A new drawdown of similar size."));
  }
  const dfh = v("drawdown_from_high");
  if (dfh !== null && dfh >= t.drawdown_medium) und.push(mk("underlying", "drawdown", "medium", `The price is ${pct(dfh, 1)} below its 52-week high.`, ["drawdown_from_high"], "The asset is in a deep drawdown; trend risk.", "high", "Understand the cause before averaging in.", "Price recovers above the 200-day average."));
  const vs = v("price_vs_sma200");
  if (vs !== null && vs <= -t.below_sma200_pct) und.push(mk("underlying", "trend", "medium", `The price is ${pct(-vs, 1)} below its 200-day average.`, ["price_vs_sma200", "sma_200"], "Persistent downtrend.", "medium", "Wait for trend confirmation or size smaller.", "Close back above the 200-day average."));
  if (!etf) {
    if (pe !== null) {
      const sev: Severity = pe >= t.pe_high ? "high" : pe >= t.pe_medium ? "medium" : "low";
      if (sev !== "low") und.push(mk("underlying", "valuation", sev, `Trailing P/E is ${pe}x.`, ["pe_ttm", "eps_ttm", ...ev("sec_eps_diluted")], "Vulnerable to multiple compression if growth disappoints.", "medium", "Compare with growth and peers.", `P/E rises above ${t.pe_high}x.`));
    }
    const ps = v("ps_ttm");
    if (ps !== null && ps >= t.ps_high) und.push(mk("underlying", "valuation", "medium", `Price/sales is ${ps}x.`, ["ps_ttm"], "Rich valuation relative to revenue.", "medium", "Check margins and growth.", null));
    const ni = v("net_income_ttm");
    const fcf = v("fcf_ttm");
    if (ni !== null && ni < 0) und.push(mk("underlying", "profitability", fcf !== null && fcf < 0 ? "high" : "medium", `Trailing net income is negative (${ni.toLocaleString("en-US")} USD).`, ["net_income_ttm", ...ev("sec_net_income")], "The company is not currently profitable.", "high", "Review the path to profitability.", "Net income turns positive."));
    if (fcf !== null && fcf < 0) und.push(mk("underlying", "cash_flow", "high", `Trailing free cash flow is negative (${fcf.toLocaleString("en-US")} USD).`, ["fcf_ttm"], "Cash burn may require financing.", "medium", "Check liquidity and funding.", "Free cash flow turns positive."));
    const ndf = v("net_debt_to_fcf");
    if (ndf !== null && ndf >= t.net_debt_to_fcf_high) und.push(mk("underlying", "leverage", "medium", `Net debt is ${ndf}x annual free cash flow (indicative).`, ["net_debt_to_fcf", "net_debt"], "Debt service competes with shareholder returns.", "low", "Review maturities and covenants.", null));
    const g = v("revenue_growth_fy");
    if (g !== null && g < 0) und.push(mk("underlying", "growth", "medium", `Revenue fell ${pct(-g, 1)} in the latest fiscal year.`, ["revenue_growth_fy"], "Shrinking sales undermine the valuation.", "medium", "Understand the driver.", "Revenue growth stays negative."));
    if (!i.snapshot.facts.fundamentals) und.push(mk("underlying", "data_availability", "medium", "SEC fundamentals were not available; valuation and profitability risks are not assessed.", [], "Fundamental risks are invisible in this report.", "low", "Retry or review filings manually.", null));
  } else {
const lt = i.lookthrough;
    if (lt && lt.status === "ok" && lt.top10_weight !== null) {
      const top = lt.top[0];
      const sev: Severity = lt.top10_weight >= 0.5 ? "high" : lt.top10_weight >= 0.35 ? "medium" : "low";
      und.push(mk("underlying", "holdings_concentration", sev, `Top 10 holdings are ${pct(lt.top10_weight, 1)} of ${sym} (${lt.count} holdings as of ${lt.as_of ?? "n/a"}); largest is ${top ? `${top.ticker} at ${pct(top.weight, 1)}` : "n/a"}.`, [], "A few names drive the fund's returns, so it is less diversified than the headline count suggests.", "high", "Check overlap with other holdings before adding exposure.", null));
    } else {
      und.push(mk("underlying", "fund_structure", "low", `${sym} is an ETF: holdings concentration could not be assessed (${lt?.reason ?? "look-through not retrieved"}); expense ratio and tracking are also not assessed.`, [], "Look-through risks are unquantified.", "low", "Review the fund's holdings and prospectus.", null));
    }
  }
  const lq = v("avg_dollar_volume_3m");
  if (lq !== null && lq < 5e7) und.push(mk("underlying", "liquidity", "medium", `Average daily dollar volume is only ${Math.round(lq).toLocaleString("en-US")} USD.`, ["avg_dollar_volume_3m"], "Wide spreads and slippage on the underlying.", "medium", "Check market depth.", null));

  // ── Token wrapper ─────────────────────────────────────────────────────────
  const tf = i.snapshot.facts.token;
  const tcfg = i.dossier.token;
  if (!tcfg) {
    tok.push(mk("token", "token_missing", "high", "No token contract was supplied, so the tokenized wrapper (contract, custody, redemption) was not assessed.", [], "Only the underlying is analysed; token-specific risk is unknown.", "high", "Provide the BNB Chain contract address.", null));
  } else if (!tf) {
    tok.push(mk("token", "contract_verification", "high", "The token contract could not be read from the chain (RPC unreachable).", [], "No on-chain verification was possible.", "high", "Retry the on-chain check.", null));
  } else {
    if (!tf.has_code) tok.push(mk("token", "contract_verification", "critical", `No contract exists at ${tcfg.contract_address} on ${tcfg.chain}.`, ev("token_contract_exists"), "The address is not a token; funds sent there may be unrecoverable.", "high", "Do not transact; obtain the correct address from the issuer's official channel.", "A deployed token contract is found at the address."));
    for (const c of i.evidence.conflicts.filter((x) => x.field.startsWith("token_"))) tok.push(mk("token", "contract_verification", "high", c.note, ev(c.field), "The contract does not match what the issuer says it is.", "high", "Confirm the address via the issuer's official site and a block explorer.", "Claim and chain agree."));
    if (tf.paused) tok.push(mk("token", "transfer_halt", "critical", "The contract reports paused() = true: transfers are currently halted.", ev("token_pausable"), "Holders cannot transfer or sell.", "high", "Understand why it is paused before any action.", "paused() returns false."));
    else if (tf.pausable) tok.push(mk("token", "admin_controls", "medium", "The contract exposes paused(): an authority can halt transfers.", ev("token_pausable"), "Transfers could be frozen by the issuer or an admin.", "high", "Identify who holds the pause role.", "Pause authority is renounced or time-locked."));
    if (tf.implementation) tok.push(mk("token", "upgradeability", tf.proxy_admin ? "high" : "medium", `The token is an upgradeable proxy (implementation ${tf.implementation})${tf.proxy_admin ? `; admin ${tf.proxy_admin}` : ""}. The logic can change without holder consent.`, ev("token_upgradeable"), "Behaviour, fees or restrictions could change after you buy.", "high", "Review the upgrade authority, timelock and multisig.", "The implementation address changes."));
    if (tf.owner && tf.owner_is_contract === false) tok.push(mk("token", "admin_controls", "high", `The token owner ${tf.owner} is an externally owned account (a single key).`, ev("token_owner"), "A single compromised key could alter or drain the token's controls.", "high", "Ask the issuer to move control to a multisig/timelock.", "Ownership moves to a contract with multiple signers."));
    const pd = v("token_premium_discount");
    if (pd !== null) {
      const a = Math.abs(pd);
      const sev: Severity = a >= t.premium_discount_critical ? "critical" : a >= t.premium_discount_high ? "high" : a >= t.premium_discount_medium ? "medium" : "low";
      if (sev !== "low") tok.push(mk("token", "peg_deviation", sev, `The on-chain feed price is ${pct(Math.abs(pd), 2)} ${pd < 0 ? "below" : "above"} the reference value of the underlying.`, ["token_premium_discount", ...ev("token_feed_price")], pd < 0 ? "Selling or redeeming through the market loses value versus the underlying." : "Buying pays above the underlying's value.", "medium", "Check market hours, liquidity and the feed's methodology.", `The deviation exceeds ${pct(t.premium_discount_critical, 0)}.`));
    } else if (tcfg && !tcfg.price_feed) {
      tok.push(mk("token", "peg_deviation", "low", "No on-chain price feed supplied: the token's market price versus its reference value was not assessed.", [], "A depeg would go unnoticed.", "low", "Supply a Chainlink-style feed or pool address.", null));
    }
    const fa = v("token_feed_age_days");
    if (fa !== null && fa > t.feed_stale_days) tok.push(mk("token", "oracle_staleness", "medium", `The price feed was last updated ${round(fa, 1)} days before the latest block.`, ev("token_feed_price"), "Stale prices can mislead valuation and liquidation logic.", "medium", "Check feed heartbeat and market hours.", null));
    const br = v("backing_ratio");
    if (br !== null) {
      const sev: Severity = br < t.backing_ratio_critical ? "critical" : br < t.backing_ratio_medium ? "high" : "low";
      if (sev !== "low") tok.push(mk("token", "backing", sev, `The issuer's stated custody covers only ${pct(br, 2)} of the shares implied by the on-chain supply.`, ["backing_ratio", ...ev("custody")], "Tokens may be under-backed.", "medium", "Demand an independent reserve attestation.", "An independent attestation shows full backing."));
    }
  }
  const cust = gapOf("custody");
  if (tcfg && cust) tok.push(mk("token", "custody", cust.severity === "high" ? "high" : "medium", cust.description, ev("custody"), "The shares behind the token may not exist or may be exposed to the custodian's insolvency.", "high", "Obtain an independent custody attestation.", "A custodian attests to segregated holdings."));
  const back = gapOf("backing");
  if (tcfg && back) tok.push(mk("token", "backing", back.severity === "high" ? "high" : "medium", back.description, ev("backing"), "Holders' claim on the underlying shares is unproven.", "high", "Obtain a reserve report or attestation.", "Independent proof of reserves is provided."));
  if (tcfg && i.dossier.claims?.backing === "synthetic") tok.push(mk("token", "backing", "high", "The issuer states the token is synthetic: holders may have no claim on the underlying shares.", ev("backing"), "Exposure without ownership.", "high", "Read the terms on holder rights.", null));
  const entry = v("redemption_entrypoints");
  if (tcfg && tf && i.dossier.claims?.redemption?.available && entry === 0)
    tok.push(mk("token", "redemption_path", "medium", `The issuer says the token is redeemable, but no burn/redeem entry point was found in the token${tf.implementation ? " or its implementation" : ""} bytecode; redemption may run through an off-chain issuer process that cannot be observed on-chain.`, ["redemption_entrypoints"], "The redemption route cannot be confirmed from the contract.", "medium", "Obtain the issuer's redemption procedure and test a small redemption.", null));
  const red = gapOf("redemption");
  if (tcfg && red) tok.push(mk("token", "redemption", "medium", red.description, ev("redemption"), "Exit at net asset value may not be possible.", "medium", "Confirm redemption terms with the issuer.", "Redemption works as described in a test."));
  if (tcfg && i.dossier.claims?.redemption && !i.dossier.claims.redemption.available) tok.push(mk("token", "redemption", "high", "The issuer states redemption is not available: exit depends entirely on secondary-market liquidity.", ev("redemption"), "Exit only through the market, possibly at a discount.", "high", "Assess on-chain liquidity depth.", null));
  if (tcfg && (i.dossier.claims?.kyc_required || i.dossier.claims?.transfer_restrictions)) tok.push(mk("token", "transfer_restrictions", "medium", "Transfers are restricted (KYC and/or allow-listing), which may limit who can buy, sell or redeem.", ev("transfer_restrictions"), "Liquidity limited to eligible holders; jurisdictional exclusions may apply.", "medium", "Check eligibility and jurisdictional restrictions.", null));
  const lg = gapOf("legal");
  if (tcfg && lg) tok.push(mk("token", "legal_structure", "medium", lg.description, [], "Holder rights and securities treatment are unclear.", "medium", "Obtain a legal opinion.", null));
  const au = gapOf("audit");
  if (tcfg && au) tok.push(mk("token", "assurance", "medium", au.description, [], "No third-party assurance on contract or reserves.", "medium", "Obtain an audit report.", null));
  for (const c of i.evidence.conflicts.filter((x) => !x.field.startsWith("token_symbol") && !x.field.startsWith("token_name") && !x.field.startsWith("token_decimals"))) {
    tok.push(mk("token", "document_integrity", c.material ? "high" : "medium", `${c.note} Sources: ${c.values.map((x) => `${x.source}=${x.value}`).join("; ")}.`, ev(c.field), "Documents and the chain disagree, so one of them is wrong.", "high", "Reconcile with the issuer.", "Reconciliation confirms the on-chain figure."));
  }
  if (i.evidence.injection_findings.length) tok.push(mk("token", "document_integrity", "high", `${i.evidence.injection_findings.length} document line(s) contain instruction-like content aimed at automated reviewers (${[...new Set(i.evidence.injection_findings.map((f) => f.pattern))].join(", ")}). They were ignored.`, i.evidence.injection_findings.map((f) => f.doc_id), "Possible attempt to manipulate the assessment; document authenticity is in question.", "medium", "Treat the documents as suspect; request originals from the issuer's official channel.", null));

  const sort = (a: Risk, b: Risk) => RANK[b.severity] - RANK[a.severity] || a.risk_id.localeCompare(b.risk_id);
  return { market: market.sort(sort), underlying: und.sort(sort), token: tok.sort(sort) };
}

export const allRisks = (r: RiskRegisters): Risk[] => [...r.token, ...r.underlying, ...r.market];

export interface RiskCoverage {
  assessed: { scope: Risk["scope"]; category: string; basis: string }[];
  not_assessed: { scope: Risk["scope"]; category: string; reason: string }[];
}

export function riskCoverage(i: RiskInputs): RiskCoverage {
  const a: RiskCoverage["assessed"] = [];
  const n: RiskCoverage["not_assessed"] = [];
  const etf = UNIVERSE[i.dossier.underlying].kind === "etf";
  const has = (id: string) => val(i.byId, id) !== null;
  const put = (ok: boolean, scope: Risk["scope"], category: string, basis: string, reason: string) => (ok ? a.push({ scope, category, basis }) : n.push({ scope, category, reason }));
  put(has("beta_spy_1y"), "market", "market_sensitivity", "1-year beta and beta-implied market scenarios.", "Beta could not be computed.");
  put(i.market.attractiveness.label !== "unknown", "market", "market_regime", "SPY trend, drawdown and 12-month return.", "Not enough SPY history.");
  put(i.market.rates.treasury_10y !== null, "market", "rates_and_financing", "10-year and 3-month Treasury yields and the curve.", "No rates data.");
  put(has("volatility_1y"), "underlying", "volatility", "1-year realised volatility.", "Insufficient price history.");
  put(has("max_drawdown_1y"), "underlying", "drawdown", "1-year maximum drawdown and distance from the 52-week high.", "Insufficient price history.");
  put(has("avg_dollar_volume_3m"), "underlying", "liquidity", "3-month average dollar volume of the underlying.", "No volume data.");
  if (!etf) {
    put(has("pe_ttm"), "underlying", "valuation", "P/E and price/sales from SEC filings.", "SEC earnings unavailable or non-positive.");
    put(has("fcf_ttm"), "underlying", "cash_flow", "Free cash flow from SEC filings.", "SEC cash-flow facts unavailable.");
    put(has("net_debt_to_fcf"), "underlying", "leverage", "Net debt / FCF (indicative).", "Debt, cash or FCF unavailable.");
  } else n.push({ scope: "underlying", category: "fund_look_through", reason: "No ETF holdings, expense ratio or tracking data is integrated." });
  n.push({ scope: "underlying", category: "event_and_regulatory", reason: "No news, earnings-date, litigation or regulatory feeds are integrated." });
  n.push({ scope: "underlying", category: "options_implied_risk", reason: "No options-implied volatility data is integrated." });
  put(!!i.snapshot.facts.token?.has_code, "token", "contract_verification", "On-chain code, name, symbol, decimals, supply, admin and upgrade controls.", "No readable token contract.");
  put(!!i.snapshot.facts.token?.feed, "token", "peg_deviation", "Chainlink-style feed price vs the underlying reference value.", "No readable price feed supplied.");
  a.push({ scope: "token", category: "custody_backing_redemption", basis: "Issuer claims vs documents and referenced attestations (not legal verification)." });
  n.push({ scope: "token", category: "on_chain_liquidity", reason: "No DEX pool or order-book depth is integrated; secondary-market liquidity is not measured." });
  n.push({ scope: "token", category: "holder_concentration", reason: "No holder-distribution indexer is integrated." });
  n.push({ scope: "token", category: "bridge_and_cross_chain", reason: "Cross-chain / bridge risk (e.g. OFT) is not assessed." });
  n.push({ scope: "token", category: "issuer_counterparty", reason: "The issuer's financial condition and regulatory standing are not independently checked." });
  return { assessed: a, not_assessed: n };
}
