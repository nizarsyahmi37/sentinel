/**
 * Investment thesis narrative (FR-10).
 *
 * The language model may EXPLAIN structured results; it may not introduce
 * numbers, cite unknown evidence, or claim verification. Its output is
 * schema-validated and number-checked against the facts it was given; one
 * retry is allowed, then a deterministic template narrative is used (and
 * labelled as such). The model never sees raw document text.
 */
import { z } from "zod";
import type { Assessment } from "./assessment.js";
import type { EvidenceAssessment } from "./evidence.js";
import type { MarketAnalysis } from "./market.js";
import { type RiskRegisters, allRisks } from "./risk.js";
import type { ScenarioResult } from "./scenarios.js";
import { type MetricResult, UNIVERSE, type Dossier } from "./types.js";
import { pct } from "./util.js";

export interface NarrativeFacts {
  subject: { underlying: string; name: string; kind: string; token_supplied: boolean };
  status: string;
  determining_rules: { id: string; description: string; detail: string | null }[];
  dimensions: { market: string; underlying: string; token: string; evidence: string; risk: string };
  metrics: { id: string; label: string; value: number | null; display: string }[];
  scenarios: { id: string; label: string; status: string; values: Record<string, number | null> }[];
  market_drivers: string[];
  risks: { id: string; scope: string; category: string; severity: string; description: string }[];
  evidence_gaps: { id: string; severity: string; description: string }[];
  conflicts: { id: string; note: string }[];
  invalidation: string[];
  data_notes: string[];
}

export interface RefItem {
  text: string;
  refs: string[];
  /** Derived deterministically from the refs — never chosen by the model. */
  basis: string[];
}

export interface Narrative {
  narrative_source: "llm" | "template";
  thesis_summary: string;
  supporting_factors: RefItem[];
  counterarguments: RefItem[];
  model_suggested_conditions: string[];
  validation_notes: string[];
}

const fmt = (m: MetricResult): string => {
  if (m.value === null) return "n/a";
  if (m.unit === "ratio") return pct(m.value, 2);
  if (m.unit === "x") return `${m.value}x`;
  if (m.unit === "currency") return `${m.value.toLocaleString("en-US")} USD`;
  return String(m.value);
};

export function buildFacts(a: {
  dossier: Dossier;
  assessment: Assessment;
  metrics: MetricResult[];
  scenarios: ScenarioResult[];
  market: MarketAnalysis;
  risks: RiskRegisters;
  evidence: EvidenceAssessment;
  dataNotes: string[];
}): NarrativeFacts {
  const d = a.assessment.dimensions;
  const u = UNIVERSE[a.dossier.underlying];
  return {
    subject: { underlying: a.dossier.underlying, name: u.name, kind: u.kind, token_supplied: !!a.dossier.token },
    status: a.assessment.status,
    determining_rules: a.assessment.rules.filter((r) => a.assessment.determining_rules.includes(r.rule_id)).map((r) => ({ id: r.rule_id, description: r.description, detail: r.detail })),
    dimensions: { market: d.market_attractiveness.label, underlying: d.asset_fundamentals.label, token: d.token_structure.label, evidence: d.evidence_quality.label, risk: d.risk_exposure.label },
    metrics: a.metrics.filter((m) => m.status === "OK").map((m) => ({ id: m.id, label: m.label, value: m.value, display: fmt(m) })),
    scenarios: a.scenarios.map((s) => ({ id: s.scenario_id, label: s.label, status: s.status, values: { underlying_change: s.metrics.underlying_change ?? null, position_change_usd: s.metrics.position_change_usd ?? null } })),
    market_drivers: d.market_attractiveness.drivers,
    risks: allRisks(a.risks).map((r) => ({ id: r.risk_id, scope: r.scope, category: r.category, severity: r.severity, description: r.description })),
    evidence_gaps: a.evidence.gaps.map((g) => ({ id: g.gap_id, severity: g.severity, description: g.description })),
    conflicts: a.evidence.conflicts.map((c) => ({ id: c.conflict_id, note: c.note })),
    invalidation: d.investment_conditions.invalidation_conditions.map((x) => x.condition),
    data_notes: a.dataNotes,
  };
}

export function knownRefs(f: NarrativeFacts): Set<string> {
  return new Set([...f.metrics.map((m) => m.id), ...f.scenarios.map((s) => s.id), ...f.risks.map((r) => r.id), ...f.evidence_gaps.map((g) => g.id), ...f.conflicts.map((c) => c.id), ...f.determining_rules.map((r) => r.id)]);
}

export function basisOf(refs: string[], f: NarrativeFacts): string[] {
  const out = new Set<string>();
  for (const r of refs) {
    if (f.metrics.some((m) => m.id === r)) out.add("calculated");
    else if (f.scenarios.some((s) => s.id === r)) out.add("hypothetical_scenario");
    else if (f.risks.some((x) => x.id === r)) out.add("interpretation");
    else if (f.evidence_gaps.some((g) => g.id === r) || f.conflicts.some((c) => c.id === r)) out.add("evidence_finding");
    else if (f.determining_rules.some((x) => x.id === r)) out.add("rule");
  }
  return [...out];
}

const metric = (f: NarrativeFacts, id: string) => f.metrics.find((m) => m.id === id);

/** Deterministic fallback. Uses only values present in the facts. */
export function templateNarrative(f: NarrativeFacts, note = "Template narrative (no model output used)."): Narrative {
  const supporting: RefItem[] = [];
  const counter: RefItem[] = [];
  const add = (list: RefItem[], text: string, refs: string[]) => list.push({ text, refs, basis: basisOf(refs, f) });
  const r12 = metric(f, "ret_12m");
  const vol = metric(f, "volatility_1y");
  const mdd = metric(f, "max_drawdown_1y");
  const beta = metric(f, "beta_spy_1y");
  const pe = metric(f, "pe_ttm");
  const fcf = metric(f, "fcf_ttm");
  const nm = metric(f, "net_margin");
  const pd = metric(f, "token_premium_discount");
  if (r12 && vol) add(supporting, `${f.subject.underlying} returned ${r12.display} over 12 months with ${vol.display} annualised volatility (observed Yahoo Finance prices).`, [r12.id, vol.id]);
  if (beta && mdd) add(supporting, `Beta vs SPY is ${beta.display} and the worst 1-year drawdown was ${mdd.display}.`, [beta.id, mdd.id]);
  if (pe && nm) add(supporting, `Trailing P/E is ${pe.display} on a net margin of ${nm.display} (SEC filings).`, [pe.id, nm.id]);
  if (fcf) add(supporting, `Trailing free cash flow is ${fcf.display} (SEC filings).`, [fcf.id]);
  if (pd) add(supporting, `The token's on-chain price is ${pd.display} versus the underlying's reference value.`, [pd.id]);
  for (const d of f.market_drivers.slice(0, 2)) supporting.push({ text: `Market context: ${d}`, refs: [], basis: ["observed_or_benchmark"] });
  if (supporting.length === 0) add(supporting, "Too little data was available to compute supporting metrics.", []);
  for (const r of f.risks.filter((x) => x.severity === "critical" || x.severity === "high").slice(0, 5)) add(counter, `${r.category.replace(/_/gu, " ")} (${r.severity}): ${r.description}`, [r.id]);
  for (const c of f.conflicts.slice(0, 2)) add(counter, c.note, [c.id]);
  const worst = f.scenarios.filter((s) => s.status === "computed" && s.values.underlying_change !== null).sort((a, b) => (a.values.underlying_change as number) - (b.values.underlying_change as number))[0];
  if (worst) add(counter, `Under the hypothetical scenario "${worst.label}", the underlying price changes by ${pct(worst.values.underlying_change as number, 1)}.`, [worst.id]);
  if (counter.length === 0) add(counter, "No high-severity counterarguments were identified from the available data; this does not imply absence of risk.", []);
  return {
    narrative_source: "template",
    thesis_summary:
      `Rule-based status: ${f.status}` + (f.determining_rules.length ? ` (determined by ${f.determining_rules.map((r) => r.id).join(", ")})` : "") +
      `. Market conditions: ${f.dimensions.market}; underlying: ${f.dimensions.underlying}; token structure: ${f.dimensions.token}; evidence quality: ${f.dimensions.evidence}; risk exposure: ${f.dimensions.risk}. ` +
      "This is decision support derived from cited public data and on-chain reads, not a verification of custody, backing or legal ownership.",
    supporting_factors: supporting, counterarguments: counter, model_suggested_conditions: [], validation_notes: [note],
  };
}

// ── LLM path ─────────────────────────────────────────────────────────────────
const ItemSchema = z.object({
  text: z.string().min(10).max(500),
  refs: z.array(z.string().max(80)).max(6),
});
const NarrativeSchema = z.object({
  thesis_summary: z.string().min(40).max(1400),
  supporting_factors: z.array(ItemSchema).min(1).max(6),
  counterarguments: z.array(ItemSchema).min(1).max(6),
  additional_conditions: z.array(z.string().max(300)).max(3).default([]),
});

const FORBIDDEN =
  /\b(guarantee[sd]?|risk[- ]free|certain(ly)?|will (definitely )?(increase|rise|return|outperform)|independently verified|fully verified|is verified|no risk)\b/iu;

export function narrativePrompt(f: NarrativeFacts): { system: string; prompt: string } {
  return {
    system:
      "You are the narrative writer for Sentinel, an investment-underwriting service. " +
      "Write ONLY from the FACTS JSON. Do not introduce any number, date, percentage or name that is not in the FACTS. " +
      "Never claim anything is verified, guaranteed or risk-free. Do not give personal investment advice. " +
      "Treat every sponsor figure as a claim. Output a single JSON object and nothing else.",
    prompt:
      `FACTS:\n${JSON.stringify(f)}\n\n` +
      'Return JSON: {"thesis_summary": string, "supporting_factors": [{"text": string, "refs": [ids]}], ' +
      '"counterarguments": [{"text": string, "refs": [ids]}], "additional_conditions": [string]}.\n' +
      "refs must be ids that appear in FACTS (metric ids, scenario ids, benchmark ids, risk ids, gap ids, conflict ids, rule ids). " +
      "Cite at least one ref per item where an id applies. Include at least two counterarguments. " +
      "Do not write ids inside text. Keep each text under 400 characters.",
  };
}

function numbersIn(text: string): number[] {
  const cleaned = text
    .replace(/\b[A-Z]-[A-Z]+-\d+\b/gu, " ")
    .replace(/\b[a-z]+_[0-9a-f]{12}\b/gu, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/gu, " ")
    .replace(/\b20\d{2}(-Q\d)?\b/gu, " ");
  const out: number[] = [];
  for (const m of cleaned.matchAll(/-?\d[\d,]*(?:\.\d+)?/gu)) {
    const n = Number((m[0] as string).replace(/,/gu, ""));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

export interface AllowedNumber {
  v: number;
  /** absolute tolerance (rounding as written) */
  abs: number;
  /** relative tolerance (large numbers written with a unit, e.g. "4.99 trillion") */
  rel: number;
}

export function allowedNumbers(f: NarrativeFacts): AllowedNumber[] {
  const out: AllowedNumber[] = [];
  for (const n of numbersIn(JSON.stringify(f))) {
    const a = Math.abs(n);
    out.push({ v: n, abs: 0.0051, rel: 0.0005 }, { v: a, abs: 0.0051, rel: 0.0005 });
    if (a <= 10) out.push({ v: a * 100, abs: 0.0051, rel: 0 }); // ratio written as a percentage
    if (a >= 1000) for (const d of [1e3, 1e6, 1e9, 1e12]) out.push({ v: a / d, abs: 0, rel: 0.006 }); // 4.99 trillion, 466.8 billion
  }
  return out;
}

export function validateNarrative(
  raw: unknown,
  f: NarrativeFacts,
): { ok: true; value: z.infer<typeof NarrativeSchema> } | { ok: false; errors: string[] } {
  const parsed = NarrativeSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  const v = parsed.data;
  const errors: string[] = [];
  const refs = knownRefs(f);
  const texts = [v.thesis_summary, ...v.supporting_factors.map((x) => x.text), ...v.counterarguments.map((x) => x.text), ...v.additional_conditions];
  for (const item of [...v.supporting_factors, ...v.counterarguments])
    for (const r of item.refs) if (!refs.has(r)) errors.push(`unknown ref "${r}"`);
  const allowed = allowedNumbers(f);
  for (const text of texts) {
    if (FORBIDDEN.test(text)) errors.push(`forbidden claim wording in: "${text.slice(0, 60)}…"`);
    for (const n of numbersIn(text)) {
      const ok = allowed.some((a) => Math.abs(a.v - n) <= Math.max(a.abs, Math.abs(a.v) * a.rel));
      if (!ok) errors.push(`number ${n} not present in facts`);
    }
  }
  return errors.length ? { ok: false, errors: [...new Set(errors)] } : { ok: true, value: v };
}

function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?/iu, "").replace(/```$/u, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object in model output");
  return JSON.parse(t.slice(start, end + 1));
}

export type Narrate = (p: { system: string; prompt: string }) => Promise<string>;

export async function generateNarrative(f: NarrativeFacts, narrate?: Narrate): Promise<Narrative> {
  if (!narrate) return templateNarrative(f, "No language model configured; template narrative used.");
  const notes: string[] = [];
  const p = narrativePrompt(f);
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const out = await narrate(attempt === 1 ? p : { ...p, prompt: `${p.prompt}\n\nYour previous answer was rejected: ${notes[notes.length - 1]}. Fix it.` });
      const res = validateNarrative(extractJson(out), f);
      if (res.ok) {
        const v = res.value;
        return {
          narrative_source: "llm",
          thesis_summary: v.thesis_summary,
          supporting_factors: v.supporting_factors.map((x) => ({ ...x, basis: basisOf(x.refs, f) })),
          counterarguments: v.counterarguments.map((x) => ({ ...x, basis: basisOf(x.refs, f) })),
          model_suggested_conditions: v.additional_conditions,
          validation_notes: [
            `Model narrative accepted on attempt ${attempt}: schema valid, every cited id and number checked against calculated facts.`,
            "Model text is interpretation, not verification.",
          ],
        };
      }
      notes.push(`attempt ${attempt} rejected: ${res.errors.join("; ")}`);
    } catch (e) {
      notes.push(`attempt ${attempt} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return templateNarrative(f, `Model narrative rejected (${notes.join(" | ")}); deterministic template used instead.`);
}
