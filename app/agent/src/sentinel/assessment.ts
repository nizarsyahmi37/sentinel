/**
 * Assessment status (FR-11, PRD §8.7). Ordered, disclosed rules — no composite score.
 * Precedence: INSUFFICIENT_DATA > DO_NOT_PROCEED > NEEDS_REVIEW > CONDITIONAL_PASS.
 *
 * For a tokenized security the statuses mean:
 *   INSUFFICIENT_DATA  required data could not be obtained
 *   DO_NOT_PROCEED     a configured critical screen failed (e.g. no contract, paused, under-backed, depegged)
 *   NEEDS_REVIEW       evidence, structure or risk questions remain open
 *   CONDITIONAL_PASS   configured screens pass; diligence listed in the report is still outstanding
 * They are screening outputs, never a recommendation to buy or sell.
 *
 * A strong market or strong fundamentals can never offset a token-structure,
 * custody or evidence concern; market conditions can only downgrade.
 */
import type { Thresholds } from "./config.js";
import type { EvidenceAssessment } from "./evidence.js";
import type { MarketAnalysis } from "./market.js";
import { val } from "./metrics.js";
import { type RiskRegisters, allRisks, severityRank } from "./risk.js";
import type { ScenarioResult } from "./scenarios.js";
import { type AssessmentStatus, type Dossier, type MarketSnapshot, type MetricResult, UNIVERSE } from "./types.js";
import { pct } from "./util.js";

export interface RuleOutcome {
  rule_id: string;
  outcome: AssessmentStatus | "INFO";
  description: string;
  fired: boolean;
  detail: string | null;
  refs: string[];
}

export interface Dimension {
  label: string;
  drivers: string[];
}

export interface InvestmentConditions {
  assumptions_to_hold: string[];
  required_diligence: string[];
  invalidation_conditions: { condition: string; basis: string }[];
}

export interface Assessment {
  status: AssessmentStatus;
  determining_rules: string[];
  rules: RuleOutcome[];
  dimensions: {
    market_attractiveness: Dimension;
    asset_fundamentals: Dimension;
    token_structure: Dimension;
    evidence_quality: Dimension & { counts: Record<string, number> };
    risk_exposure: Dimension & { counts: Record<string, number> };
    investment_conditions: InvestmentConditions;
  };
  disclaimer: string;
}

export interface AssessmentInputs {
  dossier: Dossier;
  byId: Record<string, MetricResult>;
  metrics: MetricResult[];
  market: MarketAnalysis;
  snapshot: MarketSnapshot;
  scenarios: ScenarioResult[];
  evidence: EvidenceAssessment;
  risks: RiskRegisters;
  thresholds: Thresholds;
}

export const DISCLAIMER =
  "Decision support only. Not investment, legal or tax advice and not an offer or recommendation to buy, sell or redeem any security or token. Sentinel does not verify custody, backing or legal ownership, and past prices do not predict future returns. Issuer claims and extracted document values are not independently verified unless the report says so. Professional review is required before any commitment.";

const ORDER: AssessmentStatus[] = ["INSUFFICIENT_DATA", "DO_NOT_PROCEED", "NEEDS_REVIEW", "CONDITIONAL_PASS"];

export function evaluateAssessment(i: AssessmentInputs): Assessment {
  const t = i.thresholds;
  const v = (id: string) => val(i.byId, id);
  const rules: RuleOutcome[] = [];
  const add = (rule_id: string, outcome: RuleOutcome["outcome"], description: string, fired: boolean, detail: string | null, refs: string[] = []) =>
    rules.push({ rule_id, outcome, description, fired, detail: fired ? detail : null, refs });
  const etf = UNIVERSE[i.dossier.underlying].kind === "etf";
  const tf = i.snapshot.facts.token;
  const tcfg = i.dossier.token;
  const custodyGaps = i.evidence.gaps.filter((g) => (g.related_claim === "custody" || g.related_claim === "backing") && severityRank(g.severity) >= 1);

  // INSUFFICIENT_DATA
  add("R-INS-1", "INSUFFICIENT_DATA", "No price history could be retrieved for the underlying.", v("price_last") === null, i.snapshot.limitations.join(" ") || "Price source unavailable.", ["price_last"]);
  add("R-INS-2", "INSUFFICIENT_DATA", "Too little price history to compute volatility, drawdown and beta (needs ≥ 60 daily bars).", v("price_last") !== null && (v("volatility_1y") === null || v("beta_spy_1y") === null), "Volatility or beta could not be computed.", ["volatility_1y", "beta_spy_1y"]);

  // DO_NOT_PROCEED — configured critical screens
  add("R-DNP-1", "DO_NOT_PROCEED", "The supplied token address is not a deployed contract.", !!tcfg && !!tf && !tf.has_code, `No code at ${tcfg?.contract_address}.`, ["token_contract_exists"]);
  add("R-DNP-2", "DO_NOT_PROCEED", "The token contract is paused (transfers halted).", !!tf?.paused, "paused() = true.", ["token_pausable"]);
  const br = v("backing_ratio");
  add("R-DNP-3", "DO_NOT_PROCEED", `Claimed custody covers less than ${pct(t.backing_ratio_critical, 0)} of the shares implied by on-chain supply.`, br !== null && br < t.backing_ratio_critical, `Backing ratio ${br === null ? "n/a" : pct(br, 2)}.`, ["backing_ratio"]);
  const pd = v("token_premium_discount");
  add("R-DNP-4", "DO_NOT_PROCEED", `The token's on-chain price deviates ≥ ${pct(t.premium_discount_critical, 0)} from the underlying reference value.`, pd !== null && Math.abs(pd) >= t.premium_discount_critical, `Deviation ${pd === null ? "n/a" : pct(pd, 2)}.`, ["token_premium_discount"]);
  const ni = v("net_income_ttm");
  const fcf = v("fcf_ttm");
  add("R-DNP-5", "DO_NOT_PROCEED", "The underlying company has negative trailing net income and negative free cash flow.", !etf && ni !== null && ni < 0 && fcf !== null && fcf < 0, `Net income ${ni}, FCF ${fcf}.`, ["net_income_ttm", "fcf_ttm"]);

  // NEEDS_REVIEW
  add("R-REV-1", "NEEDS_REVIEW", "No readable token contract: the wrapper (contract, custody, redemption) cannot be assessed.", !tcfg || !tf, !tcfg ? "No token contract supplied." : "Token could not be read from the chain.", ["token"]);
  add("R-REV-2", "NEEDS_REVIEW", "Custody or backing is not independently verified.", !!tcfg && custodyGaps.length > 0, custodyGaps.map((g) => g.description).join(" "), ["custody", "backing"]);
  const matConf = i.evidence.conflicts.filter((c) => c.material);
  add("R-REV-3", "NEEDS_REVIEW", "Material conflicts exist between claims, documents and the chain.", matConf.length > 0, matConf.map((c) => c.note).join(" "), matConf.map((c) => c.field));
  add("R-REV-4", "NEEDS_REVIEW", "Documents contain instruction-like content aimed at automated reviewers.", i.evidence.injection_findings.length > 0, `${i.evidence.injection_findings.length} finding(s) in ${[...new Set(i.evidence.injection_findings.map((f) => f.doc_id))].join(", ")}.`);
  const m20 = i.scenarios.find((s) => s.scenario_id === "market_down_20" && s.status === "computed");
  const loss20 = m20?.metrics.underlying_change != null ? -m20.metrics.underlying_change : null;
  add("R-REV-5", "NEEDS_REVIEW", `A 20% market fall implies a loss above ${pct(t.stress_loss_review, 0)} on the underlying (beta-implied).`, loss20 !== null && loss20 > t.stress_loss_review, `Implied loss ${loss20 === null ? "n/a" : pct(loss20, 1)}.`, ["market_down_20"]);
  const top = allRisks(i.risks).filter((r) => severityRank(r.severity) >= 2);
  add("R-REV-6", "NEEDS_REVIEW", "High or critical severity risks remain open.", top.length > 0, top.map((r) => `${r.category} (${r.severity})`).join(", "), top.map((r) => r.risk_id));
  add("R-REV-7", "NEEDS_REVIEW", "Market conditions are unfavorable (a market result can downgrade but never upgrade a status).", i.market.attractiveness.label === "unfavorable", i.market.attractiveness.drivers.map((d) => `${d.driver}: ${d.direction}`).join("; "));
  const priceM = i.snapshot.metrics.find((m) => m.key === "price_last");
  add("R-REV-8", "NEEDS_REVIEW", `The latest price observation is older than ${t.price_stale_days} days or served from cache.`, !!priceM && priceM.freshness === "stale", `Last observation ${priceM?.observed_at.slice(0, 10)}.`, ["price_last"]);
  add("R-REV-9", "NEEDS_REVIEW", "SEC fundamentals were unavailable for a company stock, so valuation and profitability are unassessed.", !etf && !i.snapshot.facts.fundamentals, "No SEC facts.", ["fundamentals"]);
  const redGap = i.evidence.gaps.find((g) => g.related_claim === "redemption");
  add("R-REV-10", "NEEDS_REVIEW", "Redemption is undescribed, undocumented or stated as unavailable.", !!tcfg && (!!redGap || i.dossier.claims?.redemption?.available === false), redGap?.description ?? "Issuer states redemption is not available.", ["redemption"]);
  add("R-REV-11", "NEEDS_REVIEW", "The token price feed is stale or the on-chain price deviates materially from the reference value.", !!tf?.feed && ((v("token_feed_age_days") ?? 0) > t.feed_stale_days || (pd !== null && Math.abs(pd) >= t.premium_discount_high)), "Feed age or deviation beyond configured limits.", ["token_feed_price"]);

  // CONDITIONAL_PASS
  const blocked = rules.some((r) => r.fired && r.outcome !== "CONDITIONAL_PASS");
  add("R-PASS-1", "CONDITIONAL_PASS", "All configured screens pass and no blocking evidence, structure or risk rule fired; the listed diligence is still outstanding.", !blocked, "All blocking rules cleared.");
  add("R-GUARD-1", "INFO", "Strong market conditions or fundamentals never offset a token-structure, custody or evidence concern.", true, "Applied by rule precedence.");

  let status: AssessmentStatus = "CONDITIONAL_PASS";
  for (const s of ORDER) if (rules.some((r) => r.fired && r.outcome === s)) { status = s; break; }
  const determining = rules.filter((r) => r.fired && r.outcome === status).map((r) => r.rule_id);

  // Dimensions
  const drivers: string[] = [];
  let aLabel = "adequate";
  const vol = v("volatility_1y");
  const mdd = v("max_drawdown_1y");
  const pe = v("pe_ttm");
  if (vol !== null) drivers.push(`Volatility ${pct(vol, 1)}`);
  if (mdd !== null) drivers.push(`1y max drawdown ${pct(mdd, 1)}`);
  if (!etf) {
    if (pe !== null) drivers.push(`P/E ${pe}x`);
    const nm = v("net_margin");
    if (nm !== null) drivers.push(`Net margin ${pct(nm, 1)}`);
    if (fcf !== null) drivers.push(`FCF ${fcf.toLocaleString("en-US")} USD`);
  }
  if (v("price_last") === null || vol === null) aLabel = "unknown";
  else if ((!etf && ni !== null && ni < 0 && fcf !== null && fcf < 0) || (mdd !== null && mdd >= t.drawdown_high && (v("price_vs_sma200") ?? 0) < 0)) aLabel = "weak";
  else if (vol < t.vol_medium && (mdd ?? 0) < t.drawdown_medium && (etf || ((v("net_margin") ?? 0) >= 0.1 && (fcf ?? -1) > 0 && (pe === null || pe <= t.pe_medium)))) aLabel = "strong";

  let tLabel = "not assessed";
  const tDrivers: string[] = [];
  if (tcfg && tf) {
    const verified = i.evidence.records.some((r) => r.claim === "custody" && r.verification_status === "INDEPENDENTLY_VERIFIED") && i.evidence.records.some((r) => r.claim === "backing" && r.verification_status === "INDEPENDENTLY_VERIFIED");
    tLabel = !tf.has_code || tf.paused || (br !== null && br < t.backing_ratio_critical) ? "defective" : verified && matConf.length === 0 ? "verified" : "unverified";
    tDrivers.push(`Contract code: ${tf.has_code ? "present" : "ABSENT"}`, `Upgradeable: ${tf.implementation ? "yes" : "no proxy detected"}`, `Pausable: ${tf.pausable ? "yes" : "no"}`, `Custody/backing independently verified: ${verified ? "yes" : "no"}`);
  } else if (tcfg) tLabel = "unreadable";
  const gapCounts: Record<string, number> = {};
  for (const g of i.evidence.gaps) gapCounts[g.severity] = (gapCounts[g.severity] ?? 0) + 1;
  const riskCounts: Record<string, number> = {};
  const all = allRisks(i.risks);
  for (const r of all) riskCounts[`${r.scope}_${r.severity}`] = (riskCounts[`${r.scope}_${r.severity}`] ?? 0) + 1;
  const topSev = all.reduce((m, r) => Math.max(m, severityRank(r.severity)), -1);

  return {
    status, determining_rules: determining, rules,
    dimensions: {
      market_attractiveness: { label: i.market.attractiveness.label, drivers: i.market.attractiveness.drivers.map((d) => `${d.driver}: ${d.direction} — ${d.basis}`) },
      asset_fundamentals: { label: aLabel, drivers },
      token_structure: { label: tLabel, drivers: tDrivers },
      evidence_quality: { label: i.evidence.status, drivers: [`${i.evidence.conflicts.length} conflict(s)`, `${i.evidence.gaps.length} gap(s) by severity: ${JSON.stringify(gapCounts)}`, `${i.evidence.injection_findings.length} injection-like finding(s)`], counts: { ...i.evidence.counts_by_class } as Record<string, number> },
      risk_exposure: { label: topSev >= 3 ? "critical" : topSev === 2 ? "high" : topSev === 1 ? "moderate" : topSev === 0 ? "low" : "none identified", drivers: [`Token risks: ${i.risks.token.length}`, `Underlying risks: ${i.risks.underlying.length}`, `Market risks: ${i.risks.market.length}`], counts: riskCounts },
      investment_conditions: deriveConditions(i, status),
    },
    disclaimer: DISCLAIMER,
  };
}

export function deriveConditions(i: AssessmentInputs, status: AssessmentStatus): InvestmentConditions {
  const t = i.thresholds;
  const v = (id: string) => val(i.byId, id);
  const assumptions: string[] = [];
  const inv: { condition: string; basis: string }[] = [];
  const etf = UNIVERSE[i.dossier.underlying].kind === "etf";
  const last = v("price_last");
  const s200 = v("sma_200");
  const beta = v("beta_spy_1y");
  if (beta !== null) assumptions.push(`The underlying's sensitivity to the market stays near beta ${beta}.`);
  if (!etf && v("fcf_ttm") !== null) assumptions.push("The underlying company stays free-cash-flow positive.");
  if (i.dossier.token) assumptions.push("The token remains redeemable or exchangeable for the underlying at close to its reference value, and the custodian holds the shares the issuer states.");
  for (const a of i.dossier.assumptions ?? []) assumptions.push(`User assumption: ${a}`);

  if (last !== null && s200 !== null && last > s200) inv.push({ condition: `A close below the 200-day average (${s200}).`, basis: `Last close ${last}; trend break.` });
  const hi = v("high_52w");
  if (hi !== null) inv.push({ condition: `A fall of more than ${pct(t.drawdown_medium, 0)} from the 52-week high (below ${Math.round(hi * (1 - t.drawdown_medium) * 100) / 100}).`, basis: `52-week high ${hi}.` });
  if (i.market.rates.treasury_10y !== null) inv.push({ condition: `The 10-year Treasury yield rises ${t.monitor_yield_move_pp} pp or more above ${i.market.rates.treasury_10y}%.`, basis: "Discount-rate pressure on valuations." });
  if (!etf) {
    if (v("fcf_ttm") !== null && (v("fcf_ttm") as number) > 0) inv.push({ condition: "Trailing free cash flow turns negative.", basis: `Currently ${(v("fcf_ttm") as number).toLocaleString("en-US")} USD.` });
    if (v("pe_ttm") !== null) inv.push({ condition: `Trailing P/E rises above ${t.pe_high}x.`, basis: `Currently ${v("pe_ttm")}x.` });
    if (v("revenue_growth_fy") !== null && (v("revenue_growth_fy") as number) > 0) inv.push({ condition: "Annual revenue growth turns negative.", basis: `Latest FY growth ${pct(v("revenue_growth_fy") as number, 1)}.` });
  }
  if (i.dossier.token) {
    inv.push({ condition: `The token's on-chain price deviates more than ${pct(t.premium_discount_high, 0)} from its reference value.`, basis: "Peg deviation." });
    inv.push({ condition: "The token contract is upgraded (implementation address changes), paused, or its owner changes.", basis: "Admin controls observed on-chain." });
    inv.push({ condition: `Total token supply moves more than ${t.monitor_supply_move_pct}% without a matching custody attestation.`, basis: "Supply is observed on-chain; custody is an issuer claim." });
    inv.push({ condition: "An independent custody or reserve attestation shows fewer shares than the on-chain supply implies.", basis: "Backing is not independently verified today." });
  }
  const diligence = i.evidence.checklist.map((c) => c.item);
  diligence.push(etf ? "Read the fund's prospectus and holdings" : `Read ${i.dossier.underlying}'s latest 10-K and 10-Q`, "Confirm the token's contract address through the issuer's official channel and a block explorer", "Check eligibility, jurisdiction and tax treatment before any transaction");
  if (status === "CONDITIONAL_PASS") diligence.push("Re-run this assessment immediately before acting; market and on-chain conditions change");
  return { assumptions_to_hold: assumptions, required_diligence: [...new Set(diligence)], invalidation_conditions: inv };
}
