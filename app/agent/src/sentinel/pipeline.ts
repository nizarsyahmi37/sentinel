/**
 * Orchestration: dossier → market snapshot (prices, rates, SEC, chain) →
 * metrics → evidence → scenarios → risks → assessment → narrative → report.
 */
import { type Assessment, evaluateAssessment } from "./assessment.js";
import { type Thresholds, loadThresholds } from "./config.js";
import { type EvidenceAssessment, assessEvidence } from "./evidence.js";
import { type MarketAnalysis, analyzeMarket, buildMarketSnapshot } from "./market.js";
import { type MetricsResult, computeMetrics, val } from "./metrics.js";
import { derivedValues } from "./monitor.js";
import { type PeerAnalysis, type PeerRow, analyzePeers, attachSic, gatherPeerRows, rowFromMetrics } from "./peers.js";
import { type LookThrough, lookThroughOf } from "./holdings.js";
import { SECTOR_PEERS, gatherSectorPeers } from "./sectorPeers.js";
import { type RiskCoverage, type RiskRegisters, allRisks, buildRisks, riskCoverage } from "./risk.js";
import { type ScenarioResult, runScenarios } from "./scenarios.js";
import type { FetchLike } from "./sources.js";
import { type Narrate, type Narrative, buildFacts, generateNarrative } from "./thesis.js";
import { type Dossier, DossierSchema, type MarketSnapshot, type MetricResult, type ScenarioConfig, UNIVERSE } from "./types.js";
import { METHODOLOGY_VERSION, hashOf, pct, round, shortId } from "./util.js";

export const REPORT_SCHEMA_VERSION = "sentinel.report.v2";

export interface PipelineOptions {
  now?: Date;
  offline?: boolean;
  fetchImpl?: FetchLike;
  cacheDir?: string;
  overrides?: Partial<Record<string, number>>;
  allowSimulation?: boolean;
  narrate?: Narrate;
  thresholds?: Thresholds;
  scenarioConfig?: ScenarioConfig;
  /** Reuse a stored snapshot (reproducibility) instead of fetching. */
  snapshot?: MarketSnapshot;
  reportVersion?: number;
  previousAnalysisId?: string;
  analysisId?: string;
  onStage?: (stage: string) => void;
  /** Reuse stored peer rows (reproducibility) instead of fetching. */
  peerRows?: PeerRow[];
  /** Skip peer benchmarking (no network for peers). */
  skipPeers?: boolean;
  /** Reuse a stored ETF look-through (reproducibility). */
  lookthrough?: LookThrough | null;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export function validateDossier(input: unknown): { ok: true; dossier: Dossier; critical_missing: string[]; optional_missing: string[] } | { ok: false; errors: ValidationIssue[] } {
  const parsed = DossierSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => ({ path: i.path.join(".") || "(root)", message: i.message })) };
  const d = parsed.data;
  const errors: ValidationIssue[] = [];
  const ids = new Set<string>();
  for (const doc of d.documents) {
    if (ids.has(doc.doc_id)) errors.push({ path: "documents", message: `duplicate doc_id "${doc.doc_id}"` });
    ids.add(doc.doc_id);
  }
  for (const k of ["custody_doc_id", "terms_doc_id", "audit_doc_id", "legal_opinion_doc_id"] as const) {
    const ref = d.claims?.[k];
    if (ref && !ids.has(ref)) errors.push({ path: `claims.${k}`, message: `no document with doc_id "${ref}"` });
  }
  if (d.claims && !d.token) errors.push({ path: "claims", message: "claims describe the token wrapper; supply a token contract or omit claims" });
  if (d.position && !d.token) errors.push({ path: "position", message: "a position is held in tokens; supply the token contract" });
  if (errors.length) return { ok: false, errors };
  const optional: string[] = [];
  if (!d.token) optional.push("token.contract_address");
  else {
    if (!d.token.price_feed) optional.push("token.price_feed");
    if (!d.claims?.custodian) optional.push("claims.custodian");
    if (!d.claims?.backing) optional.push("claims.backing");
    if (!d.claims?.redemption) optional.push("claims.redemption");
    if (!d.documents.some((x) => x.kind === "custody_attestation")) optional.push("documents: custody_attestation");
  }
  return { ok: true, dossier: d, critical_missing: [], optional_missing: optional };
}

export interface Parts {
  dossier: Dossier;
  dossier_version: string;
  snapshot: MarketSnapshot;
  metrics: MetricResult[];
  byId: Record<string, MetricResult>;
  market: MarketAnalysis;
  peers: PeerAnalysis;
  lookthrough: LookThrough | null;
  evidence: EvidenceAssessment;
  scenarios: ScenarioResult[];
  risks: RiskRegisters;
  risk_coverage: RiskCoverage;
  assessment: Assessment;
  thresholds: Thresholds;
  scenario_config: ScenarioConfig;
  now: Date;
}

export async function computeAll(dossier: Dossier, opts: PipelineOptions = {}): Promise<Parts> {
  const now = opts.now ?? new Date();
  const thresholds = opts.thresholds ?? loadThresholds();
  const stage = opts.onStage ?? (() => undefined);

  stage("market_data");
  const snapshot =
    opts.snapshot ??
    (await buildMarketSnapshot(dossier, {
      now, fetchImpl: opts.fetchImpl, cacheDir: opts.cacheDir, offline: opts.offline, overrides: opts.overrides,
      allowSimulation: opts.allowSimulation ?? process.env.SENTINEL_ALLOW_SIMULATION === "1",
      priceStaleDays: thresholds.price_stale_days, fundamentalsStaleDays: thresholds.fundamentals_stale_days,
    }));

  stage("metrics");
  const mr: MetricsResult = computeMetrics(dossier, snapshot);
  const market = analyzeMarket(snapshot);

  stage("peers");
  let subjectRow = rowFromMetrics(dossier.underlying, mr.byId);
  const skip = opts.skipPeers ?? process.env.SENTINEL_PEERS === "off";
  let peerRows: PeerRow[] = opts.peerRows ?? [];
  if (opts.peerRows) {
    // reproduction: the subject's stored classification belongs to the stored snapshot
    const stored = opts.peerRows.find((r) => r.symbol === dossier.underlying);
    if (stored) subjectRow = { ...subjectRow, cik: stored.cik, sic: stored.sic, sic_description: stored.sic_description };
  }
  let sector: string | null = SECTOR_PEERS[dossier.underlying]?.sector ?? null;
  if (!opts.peerRows && !skip) {
    const uni = await gatherPeerRows(dossier.underlying, { now, fetchImpl: opts.fetchImpl, cacheDir: opts.cacheDir, offline: opts.offline, priceStaleDays: thresholds.price_stale_days, fundamentalsStaleDays: thresholds.fundamentals_stale_days });
    const sec = await gatherSectorPeers(dossier.underlying, { fetchImpl: opts.fetchImpl, offline: opts.offline, spyBars: snapshot.facts.spy_bars });
    sector = sec.sector;
    const withSic = opts.offline ? [subjectRow, ...uni, ...sec.rows] : await attachSic([subjectRow, ...uni, ...sec.rows], opts.fetchImpl);
    subjectRow = withSic[0]!;
    peerRows = withSic.slice(1);
  }
  const peers = analyzePeers(dossier.underlying, subjectRow, peerRows, val(mr.byId, "token_premium_discount"), sector);

  const lookthrough: LookThrough | null =
    UNIVERSE[dossier.underlying].kind !== "etf" ? null : opts.lookthrough !== undefined ? opts.lookthrough : skip || opts.offline ? null : await lookThroughOf(dossier.underlying, opts.fetchImpl);

  stage("evidence");
  const evidence = assessEvidence(dossier, mr.metrics, snapshot, thresholds, now);

  stage("scenarios");
  const scenario_config = { ...(dossier.scenario_config ?? {}), ...(opts.scenarioConfig ?? {}) };
  const scenarios = runScenarios(dossier, mr, scenario_config);

  stage("risk");
  const ri = { dossier, byId: mr.byId, market, snapshot, scenarios, evidence, thresholds, lookthrough };
  const risks = buildRisks(ri);
  const risk_coverage = riskCoverage(ri);

  stage("assessment");
  const assessment = evaluateAssessment({ dossier, byId: mr.byId, metrics: mr.metrics, market, snapshot, scenarios, evidence, risks, thresholds });
  return { dossier, dossier_version: shortId("dos", dossier), snapshot, metrics: mr.metrics, byId: mr.byId, market, peers, lookthrough, evidence, scenarios, risks, risk_coverage, assessment, thresholds, scenario_config, now };
}

// ── Monitoring thresholds ────────────────────────────────────────────────────
export interface MonitoringThreshold {
  threshold_id: string;
  metric: string;
  label: string;
  baseline: number | null;
  trigger: number;
  direction: "up" | "down" | "any";
  kind: "absolute" | "percent" | "level";
  affects: "market_conditions" | "asset_fundamentals" | "token_structure" | "evidence_quality";
  affected_assumptions: string[];
  note: string;
}

export function deriveMonitoringThresholds(p: Parts): MonitoringThreshold[] {
  const t = p.thresholds;
  const out: MonitoringThreshold[] = [];
  const m = (key: string) => p.snapshot.metrics.find((x) => x.key === key);
  const px = m("price_last");
  if (px) {
    out.push({ threshold_id: "price_down", metric: "price_last", label: `${p.dossier.underlying} falls`, baseline: px.value, trigger: t.monitor_price_down_pct, direction: "down", kind: "percent", affects: "asset_fundamentals", affected_assumptions: ["Position value", "Trend", "Valuation"], note: `Reassess if the price falls ${t.monitor_price_down_pct}% or more from ${px.value}.` });
    out.push({ threshold_id: "price_up", metric: "price_last", label: `${p.dossier.underlying} rallies`, baseline: px.value, trigger: t.monitor_price_up_pct, direction: "up", kind: "percent", affects: "asset_fundamentals", affected_assumptions: ["Valuation", "Extension from trend"], note: `Reassess if the price rises ${t.monitor_price_up_pct}% or more from ${px.value}.` });
  }
  const spy = m("spy_price");
  if (spy) out.push({ threshold_id: "market_down", metric: "spy_price", label: "Broad market (SPY) falls", baseline: spy.value, trigger: 8, direction: "down", kind: "percent", affects: "market_conditions", affected_assumptions: ["Market regime", "Beta-implied stress"], note: "Reassess if SPY falls 8% or more." });
  const y = m("treasury_10y");
  if (y) out.push({ threshold_id: "yield_rise", metric: "treasury_10y", label: "10-year Treasury yield rises", baseline: y.value, trigger: t.monitor_yield_move_pp, direction: "up", kind: "absolute", affects: "market_conditions", affected_assumptions: ["Valuation multiples", "Rates context"], note: `Reassess if the 10-year yield rises ${t.monitor_yield_move_pp} percentage points or more.` });
  const filing = m("latest_filing_date");
  if (filing) out.push({ threshold_id: "new_filing", metric: "latest_filing_date", label: "New SEC filing", baseline: filing.value, trigger: 1, direction: "up", kind: "absolute", affects: "evidence_quality", affected_assumptions: ["Fundamentals", "Valuation multiples"], note: "A newer 10-K/10-Q than the one used triggers reassessment." });
  if (m("token_total_supply")) {
    const s = m("token_total_supply")!;
    out.push({ threshold_id: "supply_up", metric: "token_total_supply", label: "Token supply increases", baseline: s.value, trigger: t.monitor_supply_move_pct, direction: "up", kind: "percent", affects: "token_structure", affected_assumptions: ["Backing ratio", "Custody attestation"], note: `Reassess if supply grows ${t.monitor_supply_move_pct}% or more; custody must keep pace.` });
    out.push({ threshold_id: "supply_down", metric: "token_total_supply", label: "Token supply decreases", baseline: s.value, trigger: t.monitor_supply_move_pct, direction: "down", kind: "percent", affects: "token_structure", affected_assumptions: ["Redemptions", "Backing ratio"], note: `Reassess if supply shrinks ${t.monitor_supply_move_pct}% or more.` });
  }
  if (m("token_impl_id")) out.push({ threshold_id: "contract_upgraded", metric: "token_impl_id", label: "Token contract upgraded", baseline: m("token_impl_id")!.value, trigger: 1, direction: "any", kind: "absolute", affects: "token_structure", affected_assumptions: ["Contract behaviour", "Admin controls"], note: "The EIP-1967 implementation address changed: the token's logic was upgraded." });
  if (m("token_feed_price")) {
    const f = m("token_feed_price")!;
    out.push({ threshold_id: "feed_move", metric: "token_feed_price", label: "Token price feed moves", baseline: f.value, trigger: 10, direction: "any", kind: "percent", affects: "token_structure", affected_assumptions: ["Peg to underlying"], note: "Reassess if the on-chain token price moves 10% or more." });
  }
  const dv = derivedValues(p.snapshot, p.dossier.token?.tokens_per_share ?? null, new Date(p.snapshot.observed_at));
  if (dv.drawdown_from_high !== undefined) out.push({ threshold_id: "drawdown_widens", metric: "drawdown_from_high", label: "Drawdown from 52-week high widens", baseline: dv.drawdown_from_high, trigger: t.monitor_drawdown_pp, direction: "up", kind: "absolute", affects: "asset_fundamentals", affected_assumptions: ["Trend", "Position value"], note: `Reassess if the drawdown from the 52-week high widens by ${t.monitor_drawdown_pp * 100} percentage points or more (from ${(dv.drawdown_from_high * 100).toFixed(1)}%).` });
  if (dv.token_premium !== undefined) out.push({ threshold_id: "premium_moves", metric: "token_premium", label: "Token premium/discount to underlying moves", baseline: dv.token_premium, trigger: t.monitor_premium_move, direction: "any", kind: "absolute", affects: "token_structure", affected_assumptions: ["Peg to underlying", "Oracle consistency"], note: `Reassess if the token's feed price moves ${t.monitor_premium_move * 100} percentage points or more relative to the underlying-implied value (oracle divergence; baseline ${(dv.token_premium * 100).toFixed(2)}%).` });
  if (dv.feed_age_days !== undefined) out.push({ threshold_id: "feed_stale", metric: "feed_age_days", label: "Token price feed goes stale", baseline: dv.feed_age_days, trigger: t.feed_stale_days, direction: "up", kind: "level", affects: "evidence_quality", affected_assumptions: ["Oracle freshness"], note: `Reassess if the on-chain price feed has not updated for ${t.feed_stale_days} days or more.` });
  if (dv.fundamentals_age_days !== undefined) out.push({ threshold_id: "fundamentals_stale", metric: "fundamentals_age_days", label: "SEC fundamentals age", baseline: dv.fundamentals_age_days, trigger: t.fundamentals_stale_days, direction: "up", kind: "level", affects: "evidence_quality", affected_assumptions: ["Fundamentals", "Valuation multiples"], note: `Reassess when the latest SEC filing used is ${t.fundamentals_stale_days} days old or more (evidence-age watcher).` });
  out.push({ threshold_id: "dossier_change", metric: "dossier_version", label: "Dossier or evidence changes", baseline: null, trigger: 1, direction: "up", kind: "absolute", affects: "evidence_quality", affected_assumptions: ["Custody/backing evidence", "Token facts"], note: "A new dossier version (new attestation, audit, token address) triggers reassessment." });
  return out;
}

export function marketInvalidation(m: { thresholds: MonitoringThreshold[] }): { condition: string; baseline: number | null }[] {
  return m.thresholds.filter((t) => t.affects === "market_conditions").map((t) => ({ condition: `${t.label}: ${t.note}`, baseline: t.baseline }));
}

// ── Report ───────────────────────────────────────────────────────────────────
export interface SentinelReport {
  schema_version: string;
  report_id: string;
  report_version: number;
  methodology_version: string;
  generated_at: string;
  inputs: { asset_id: string; dossier_version: string; market_snapshot_id: string; scenario_config: ScenarioConfig; thresholds: Thresholds; previous_analysis_id: string | null };
  executive_summary: { status: string; headline: string; key_figures: { label: string; value: string; basis: string }[]; top_risks: string[]; determining_rules: string[] };
  asset_overview: {
    asset_id: string; underlying: string; name: string; kind: "stock" | "etf"; currency: string | null; exchange_note: string;
    token: { chain: string; contract_address: string; issuer: string | null; tokens_per_share: number; onchain: { symbol: string | null; name: string | null; decimals: number | null; total_supply: number | null; block_number: number } | null } | null;
    position: { tokens: number; cost_basis_usd: number | null } | null;
    claims_note: string;
  };
  market: { snapshot: MarketSnapshot; analysis: MarketAnalysis };
  peers: PeerAnalysis;
  etf_lookthrough: LookThrough | null;
  asset: { metrics: MetricResult[] };
  evidence: EvidenceAssessment;
  scenarios: ScenarioResult[];
  risks: RiskRegisters;
  risk_coverage: RiskCoverage;
  assessment: Assessment;
  thesis: Narrative;
  market_thesis_invalidation: { condition: string; baseline: number | null }[];
  invalidation_conditions: { condition: string; basis: string }[];
  missing_information_checklist: EvidenceAssessment["checklist"];
  monitoring: { thresholds: MonitoringThreshold[]; note: string };
  methodology: { version: string; formulas: { id: string; formula: string }[]; notes: string[] };
  limitations: string[];
  legend: Record<string, string>;
  disclaimer: string;
  review_status: string;
  stages_completed: string[];
  hashes: { calculation_hash: string; report_hash: string };
}

const LEGEND = {
  observed: "Retrieved from a cited external source with a timestamp (Yahoo Finance, FRED, SEC EDGAR).",
  on_chain: "Read directly from the BNB Chain by a read-only RPC call at a stated block.",
  calculated: "Computed deterministically from observed inputs; formula and inputs are recorded.",
  claimed: "An issuer or user claim; not independently verified unless marked INDEPENDENTLY_VERIFIED.",
  interpreted: "Rule- or model-generated interpretation of the facts; not verification.",
  hypothetical: "A stress scenario; not a forecast.",
};

type Core = Omit<SentinelReport, "hashes" | "thesis" | "generated_at" | "executive_summary" | "stages_completed">;

export function calculationPayload(r: Core): unknown {
  return {
    inputs: r.inputs,
    market: { snapshot: { ...r.market.snapshot, sources: r.market.snapshot.sources.map((s) => ({ ...s, retrieved_at: undefined })) }, analysis: r.market.analysis },
    peers: r.peers,
    etf_lookthrough: r.etf_lookthrough,
    metrics: r.asset.metrics, scenarios: r.scenarios, evidence: r.evidence, risks: r.risks, risk_coverage: r.risk_coverage,
    market_thesis_invalidation: r.market_thesis_invalidation, assessment: r.assessment, monitoring: r.monitoring,
  };
}

export function assembleReport(p: Parts, thesis: Narrative, opts: PipelineOptions = {}): SentinelReport {
  const d = p.dossier;
  const u = UNIVERSE[d.underlying];
  const tf = p.snapshot.facts.token;
  const fig = (label: string, id: string, basis = "calculated") => {
    const m = p.byId[id];
    const v = m && m.status === "OK" && m.value !== null ? m.value : null;
    const display = v === null ? `n/a (${m?.status ?? "MISSING"})` : m!.unit === "ratio" ? pct(v, 2) : m!.unit === "x" ? `${v}x` : m!.unit === "currency" ? `${v.toLocaleString("en-US")} USD` : String(v);
    return { label, value: display, basis };
  };
  const analysisId = opts.analysisId ?? shortId("analysis", { d: p.dossier_version, s: p.snapshot.snapshot_id, c: p.scenario_config });
  const monitoring = { thresholds: deriveMonitoringThresholds(p), note: "Monitoring observes only data Sentinel can retrieve: public prices and rates, SEC filings, on-chain token state and dossier updates. It cannot see the issuer's private books or custody records." };
  const top = allRisks(p.risks).filter((r) => r.severity === "critical" || r.severity === "high").slice(0, 5).map((r) => `${r.category.replace(/_/gu, " ")} (${r.severity}): ${r.description}`);
  const rules = p.assessment.rules.filter((r) => p.assessment.determining_rules.includes(r.rule_id));
  const core: Core = {
    schema_version: REPORT_SCHEMA_VERSION, report_id: analysisId, report_version: opts.reportVersion ?? 1, methodology_version: METHODOLOGY_VERSION,
    inputs: { asset_id: d.asset_id, dossier_version: p.dossier_version, market_snapshot_id: p.snapshot.snapshot_id, scenario_config: p.scenario_config, thresholds: p.thresholds, previous_analysis_id: opts.previousAnalysisId ?? null },
    asset_overview: {
      asset_id: d.asset_id, underlying: d.underlying, name: u.name, kind: u.kind, currency: p.snapshot.facts.currency,
      exchange_note: p.snapshot.sources.some((x) => x.source_id.startsWith("polygon_")) ? "Underlying prices are daily closes from Polygon.io (licensed API; split-adjusted, not dividend-adjusted)." : "Underlying prices are daily closes from an unofficial Yahoo Finance endpoint (delayed; not a licensed feed).",
      token: d.token ? { chain: d.token.chain, contract_address: d.token.contract_address, issuer: d.token.issuer ?? null, tokens_per_share: d.token.tokens_per_share, onchain: tf ? { symbol: tf.symbol, name: tf.name, decimals: tf.decimals, total_supply: tf.total_supply, block_number: tf.block_number } : null } : null,
      position: d.position ? { tokens: d.position.tokens, cost_basis_usd: d.position.cost_basis_usd ?? null } : null,
      claims_note: "Custody, backing, redemption and legal claims come from the issuer/user. They are shown as claims unless the evidence register marks them independently verified.",
    },
    market: { snapshot: p.snapshot, analysis: p.market },
    peers: p.peers,
    etf_lookthrough: p.lookthrough,
    asset: { metrics: p.metrics },
    evidence: p.evidence, scenarios: p.scenarios, risks: p.risks, risk_coverage: p.risk_coverage, assessment: p.assessment,
    market_thesis_invalidation: marketInvalidation(monitoring),
    invalidation_conditions: [...p.assessment.dimensions.investment_conditions.invalidation_conditions, ...thesis.model_suggested_conditions.map((c) => ({ condition: c, basis: "Model-suggested; interpretation only." }))],
    missing_information_checklist: p.evidence.checklist, monitoring,
    methodology: {
      version: METHODOLOGY_VERSION,
      formulas: p.metrics.map((m) => ({ id: m.id, formula: m.formula })),
      notes: [
        "All numbers are calculated by deterministic code from cited public data and on-chain reads; a language model never produces a number.",
        "Status follows ordered, disclosed rules (INSUFFICIENT_DATA > DO_NOT_PROCEED > NEEDS_REVIEW > CONDITIONAL_PASS). Market conditions can downgrade a result but never upgrade it or offset a token-structure, custody or evidence concern.",
        "On-chain facts are what the contract returns at the stated block; custody, backing and redemption are issuer claims until independently attested.",
        "Document text is untrusted data: scanned and pattern-mined, never executed, never sent to a model.",
        "Scenario results are hypothetical stresses. Beta-implied market shocks assume a stable linear beta and ignore idiosyncratic risk.",
        `Market snapshot ${p.snapshot.snapshot_id} (${p.snapshot.data_quality_status}); dossier version ${p.dossier_version}.`,
      ],
    },
    limitations: [...p.snapshot.limitations, ...(p.snapshot.sources.some((x) => x.source_id.startsWith("yahoo_")) ? ["Yahoo Finance is an unofficial source without an SLA; obtain a licensed feed before commercial reliance (set SENTINEL_PRICE_PROVIDER=polygon and POLYGON_API_KEY)."] : []), "Sentinel does not verify custody, backing or legal ownership of the token, and does not provide investment advice."],
    legend: LEGEND, disclaimer: p.assessment.disclaimer,
    review_status: p.assessment.status === "CONDITIONAL_PASS" ? "Automated screen complete; analyst and legal review required before relying on it." : "Automated screen complete; open items require human review.",
  };
  const calcHash = hashOf(calculationPayload(core));
  const full = {
    ...core, generated_at: p.now.toISOString(),
    executive_summary: {
      status: p.assessment.status,
      headline: `${u.name} (${d.underlying})${d.token ? " token" : ""}: ${p.assessment.status.replace(/_/gu, " ")}. ${rules.map((r) => r.description).join(" ")}`.trim(),
      key_figures: [fig("Last close", "price_last", "observed"), fig("12-month return", "ret_12m"), fig("Volatility (1y)", "volatility_1y"), fig("Beta vs SPY", "beta_spy_1y"), fig("P/E (TTM)", "pe_ttm"), fig("Token premium / discount", "token_premium_discount")],
      top_risks: top, determining_rules: p.assessment.determining_rules,
    },
    thesis, stages_completed: ["market_data", "metrics", "peers", "evidence", "scenarios", "risk", "assessment", "narrative", "report"],
  };
  const reportHash = hashOf({ ...full, hashes: undefined });
  return { ...(full as unknown as Omit<SentinelReport, "hashes">), hashes: { calculation_hash: calcHash, report_hash: reportHash } };
}

export async function runAssessment(input: unknown, opts: PipelineOptions = {}): Promise<SentinelReport> {
  const v = validateDossier(input);
  if (!v.ok) {
    const err = new Error(`Invalid dossier: ${v.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
    (err as Error & { issues?: ValidationIssue[] }).issues = v.errors;
    err.name = "DossierValidationError";
    throw err;
  }
  const parts = await computeAll(v.dossier, opts);
  opts.onStage?.("narrative");
  const facts = buildFacts({ dossier: parts.dossier, assessment: parts.assessment, metrics: parts.metrics, scenarios: parts.scenarios, market: parts.market, risks: parts.risks, evidence: parts.evidence, dataNotes: [`Data quality: ${parts.snapshot.data_quality_status}`, `Valuation context: ${parts.peers.valuation_context.summary}`, ...parts.snapshot.limitations] });
  const thesis = await generateNarrative(facts, opts.narrate);
  opts.onStage?.("report");
  return assembleReport(parts, thesis, opts);
}

export { round, val };
