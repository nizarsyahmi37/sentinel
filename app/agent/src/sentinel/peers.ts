/**
 * Peer benchmarking and valuation context (FR-07).
 * Peers are the other symbols of the supported universe, computed from the
 * same real sources and the same deterministic metric code. A comparability
 * guard keeps stocks with stocks and ETFs with ETFs; valuation context is
 * context only — never a price target.
 */
import { buildMarketSnapshot } from "./market.js";
import { computeMetrics, val } from "./metrics.js";
import type { FetchLike } from "./sources.js";
import { type Dossier, DossierSchema, SYMBOLS, type Symbol, UNIVERSE } from "./types.js";
import { round } from "./util.js";

export const PEER_METRICS = [
  { id: "ret_12m", label: "12-month return", unit: "ratio", higher: "better" },
  { id: "volatility_1y", label: "Volatility (1y)", unit: "ratio", higher: "worse" },
  { id: "max_drawdown_1y", label: "Max drawdown (1y)", unit: "ratio", higher: "worse" },
  { id: "beta_spy_1y", label: "Beta vs SPY", unit: "x", higher: "neutral" },
  { id: "pe_ttm", label: "P/E (TTM)", unit: "x", higher: "richer" },
  { id: "ps_ttm", label: "Price / sales (TTM)", unit: "x", higher: "richer" },
  { id: "fcf_yield", label: "FCF yield", unit: "ratio", higher: "cheaper" },
  { id: "net_margin", label: "Net margin (TTM)", unit: "ratio", higher: "better" },
] as const;
export type PeerMetricId = (typeof PEER_METRICS)[number]["id"];

export interface PeerRow {
  /** Universe symbol, or a sector-peer ticker outside the supported universe. */
  symbol: string;
  group?: "universe" | "sector";
  /** SEC CIK (sector peers); universe symbols use the registry. */
  cik?: number | null;
  /** SEC Standard Industrial Classification code and text, when retrieved. */
  sic?: string | null;
  sic_description?: string | null;
  name?: string | null;
  kind: "stock" | "etf";
  status: "ok" | "failed";
  error: string | null;
  values: Record<string, number | null>;
}

export interface PeerComparison {
  metric: PeerMetricId;
  label: string;
  subject: number | null;
  peer_median: number | null;
  peer_count: number;
  percentile: number | null;
  vs_median: number | null;
  /** Median over peers the SEC places in the same industry as the subject (needs ≥ MIN_PEERS with data). */
  industry_median: number | null;
  industry_count: number;
  vs_industry_median: number | null;
  note: string | null;
}

export interface PeerAnalysis {
  status: "ok" | "partial" | "unavailable";
  subject: Symbol;
  subject_kind: "stock" | "etf";
  peer_set: string[];
  sector: string | null;
  excluded: { symbol: string; reason: string }[];
  /** 12-month return difference vs the SPY and QQQ benchmarks (percentage-point gap as a fraction). */
  relative_strength: { vs_spy: number | null; vs_qqq: number | null; basis: string };
  /** Official SEC industry classification of the subject and each peer (informational; peers are not excluded by it). */
  classification: { basis: string; subject: { sic: string | null; description: string | null }; same: number; different: number; unknown: number; peers: { symbol: string; sic: string | null; description: string | null; match: "same" | "different" | "unknown" }[] };
  comparable: boolean;
  comparability_note: string;
  rows: PeerRow[];
  comparisons: PeerComparison[];
  valuation_context: {
    available: boolean;
    summary: string;
    items: { metric: string; subject: number | null; peer_median: number | null; vs_median: number | null; reading: "premium" | "discount" | "in line" | "n/a" }[];
    token_vs_underlying: { premium_discount: number | null; reading: string } | null;
    caveats: string[];
  };
  min_peers: number;
}

export const MIN_PEERS = 3;

/** Attaches the SEC's own SIC code to the subject and every peer with a known CIK. Failures leave the field null (never guessed). */
export async function attachSic(rows: PeerRow[], f?: FetchLike): Promise<PeerRow[]> {
  const { fetchSic, defaultFetch } = await import("./sources.js");
  const fetchImpl = f ?? defaultFetch;
  return Promise.all(rows.map(async (r) => {
    const cik = r.cik ?? (UNIVERSE[r.symbol]?.cik ?? null);
    if (!cik || r.status !== "ok") return r;
    try {
      const s = await fetchSic(fetchImpl, cik);
      return { ...r, cik, sic: s?.sic ?? null, sic_description: s?.description ?? null };
    } catch {
      return { ...r, cik, sic: null, sic_description: null };
    }
  }));
}

export function rowFromMetrics(symbol: Symbol, byId: Parameters<typeof val>[0]): PeerRow {
  const g = (id: string) => val(byId, id);
  const mcap = g("market_cap");
  const fcf = g("fcf_ttm");
  const values: Record<string, number | null> = {};
  for (const m of PEER_METRICS) values[m.id] = m.id === "fcf_yield" ? (mcap && fcf !== null ? round(fcf / mcap) : null) : g(m.id);
  return { symbol, group: "universe", kind: UNIVERSE[symbol].kind, status: "ok", error: null, values };
}

const median = (x: number[]): number | null => {
  if (!x.length) return null;
  const s = [...x].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Fetches the same real sources for every other universe symbol (bounded concurrency). */
export async function gatherPeerRows(
  subject: Symbol,
  o: { now: Date; fetchImpl?: FetchLike; cacheDir?: string; offline?: boolean; priceStaleDays?: number; fundamentalsStaleDays?: number },
): Promise<PeerRow[]> {
  const targets = SYMBOLS.filter((s) => s !== subject);
  const out: PeerRow[] = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= targets.length) return;
      const sym = targets[i]!;
      try {
        const d: Dossier = DossierSchema.parse({ underlying: sym });
        const snap = await buildMarketSnapshot(d, { ...o, allowSimulation: false });
        if (snap.data_quality_status === "unavailable" || !snap.facts.bars.length) throw new Error("market data unavailable");
        out.push(rowFromMetrics(sym, computeMetrics(d, snap).byId));
      } catch (e) {
        out.push({ symbol: sym, group: "universe", kind: UNIVERSE[sym].kind, status: "failed", error: e instanceof Error ? e.message : String(e), values: {} });
      }
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export function analyzePeers(subject: Symbol, subjectRow: PeerRow, peerRows: PeerRow[], tokenPremium: number | null, sector: string | null = null): PeerAnalysis {
  const kind = UNIVERSE[subject].kind;
  const excluded: PeerAnalysis["excluded"] = [];
  const usable: PeerRow[] = [];
  for (const r of peerRows) {
    if (r.symbol === subject) continue;
    if (r.status !== "ok") excluded.push({ symbol: r.symbol, reason: `data unavailable: ${r.error ?? "unknown"}` });
    else if (r.kind !== kind) excluded.push({ symbol: r.symbol, reason: `${r.kind === "etf" ? "ETF" : "single stock"} is not comparable with a ${kind === "etf" ? "ETF" : "single stock"}` });
    else usable.push(r);
  }
  const comparable = usable.length >= MIN_PEERS;
  const note = comparable
    ? `${usable.length} comparable ${kind === "etf" ? "ETFs" : "stocks"}: ${usable.map((r) => r.symbol).join(", ")}. Universe symbols plus a curated, disclosed sector list (not an official industry classification).`
    : `Not sufficiently comparable: only ${usable.length} comparable ${kind === "etf" ? "ETF" : "stock"} peer(s) with data (need ${MIN_PEERS}). Relative statistics are shown only where at least ${MIN_PEERS} peers exist.`;

  const comparisons: PeerComparison[] = PEER_METRICS.map((m) => {
    const sv = subjectRow.values[m.id] ?? null;
    const pv = usable.map((r) => r.values[m.id]).filter((x): x is number => x !== null && Number.isFinite(x));
    const enough = pv.length >= MIN_PEERS;
    const med = enough ? median(pv) : null;
    const pct = enough && sv !== null ? pv.filter((x) => x <= sv).length / pv.length : null;
    let n: string | null = null;
    if (sv === null) n = kind === "etf" && ["pe_ttm", "ps_ttm", "fcf_yield", "net_margin"].includes(m.id) ? "not applicable to ETFs" : "subject value unavailable";
    else if (!enough) n = `fewer than ${MIN_PEERS} peers with this metric`;
    const sameVals = usable.filter((r) => subjectRow.sic && r.sic === subjectRow.sic).map((r) => r.values[m.id]).filter((x): x is number => x !== null && x !== undefined && Number.isFinite(x));
    const indMed = sameVals.length >= MIN_PEERS ? median(sameVals) : null;
    return {
      industry_median: indMed === null ? null : round(indMed), industry_count: sameVals.length, vs_industry_median: indMed !== null && sv !== null && indMed !== 0 ? round(sv / indMed - 1) : null,
      metric: m.id, label: m.label, subject: sv, peer_median: med === null ? null : round(med), peer_count: pv.length,
      percentile: pct === null ? null : round(pct, 2), vs_median: med !== null && sv !== null && med !== 0 ? round(sv / med - 1) : null, note: n,
    };
  });

  const reading = (v: number | null): "premium" | "discount" | "in line" | "n/a" => (v === null ? "n/a" : v > 0.15 ? "premium" : v < -0.15 ? "discount" : "in line");
  const valItems = comparisons.filter((c) => ["pe_ttm", "ps_ttm", "fcf_yield"].includes(c.metric)).map((c) => ({
    metric: c.label, subject: c.subject, peer_median: c.peer_median, vs_median: c.vs_median,
    // for FCF yield a lower yield means richer, so flip the reading
    reading: c.metric === "fcf_yield" ? reading(c.vs_median === null ? null : -c.vs_median) : reading(c.vs_median),
  }));
  const haveVal = kind === "stock" && comparable && valItems.some((v) => v.reading !== "n/a");
  const caveats = [
    "Valuation context compares multiples with the listed peers only (supported universe plus a curated sector list); it is not a price target or a fair-value estimate.",
    "TTM multiples reflect trailing results and differ in growth, margins, accounting and share classes.",
    ...(kind === "etf" ? ["ETFs have no company financial statements; valuation multiples do not apply, only price/risk comparison."] : []),
  ];
  const summary = !haveVal
    ? kind === "etf" ? "Valuation multiples do not apply to ETFs; compare price and risk metrics only." : "Valuation context unavailable: not enough comparable peers with fundamentals."
    : `Versus ${usable.length} peers: ${valItems.filter((v) => v.reading !== "n/a").map((v) => `${v.metric} ${v.reading}${v.vs_median === null ? "" : ` (${v.vs_median >= 0 ? "+" : ""}${(v.vs_median * 100).toFixed(0)}% vs median)`}`).join("; ")}.`;
  const tvu = tokenPremium === null ? null : {
    premium_discount: tokenPremium,
    reading: Math.abs(tokenPremium) < 0.01 ? "token trades in line with its underlying" : `token trades at a ${tokenPremium > 0 ? "premium" : "discount"} of ${(Math.abs(tokenPremium) * 100).toFixed(2)}% to its underlying`,
  };
  const status: PeerAnalysis["status"] = !comparable ? (usable.length ? "partial" : "unavailable") : excluded.some((e) => e.reason.startsWith("data")) ? "partial" : "ok";
  const bench = (sym: string) => {
    const r = peerRows.find((x) => x.symbol === sym && x.status === "ok")?.values.ret_12m;
    const mine = subjectRow.values.ret_12m;
    return sym === subject || r === undefined || r === null || mine === null || mine === undefined ? null : round(mine - r);
  };
  const subSic = subjectRow.sic ?? null;
  const cls = usable.map((r) => ({ symbol: r.symbol, sic: r.sic ?? null, description: r.sic_description ?? null, match: (subSic === null || !r.sic ? "unknown" : r.sic === subSic ? "same" : "different") as "same" | "different" | "unknown" }));
  const classification = { basis: "SEC Standard Industrial Classification (official but coarse; informational — peers are not excluded by it)", subject: { sic: subSic, description: subjectRow.sic_description ?? null }, same: cls.filter((c) => c.match === "same").length, different: cls.filter((c) => c.match === "different").length, unknown: cls.filter((c) => c.match === "unknown").length, peers: cls };
  const sameN = cls.filter((c) => c.match === "same").length;
  const industryNote = subSic === null ? "" : sameN >= MIN_PEERS ? ` Only ${sameN} of ${usable.length} peers share the subject's SEC industry (SIC ${subSic}); same-industry statistics are shown separately.` : ` Only ${sameN} of ${usable.length} peers share the subject's SEC industry (SIC ${subSic}), too few for same-industry statistics.`;
  const relative_strength = { vs_spy: bench("SPY"), vs_qqq: bench("QQQ"), basis: "subject 12-month return minus the benchmark ETF's 12-month return (dividend-adjusted closes)" };
  return {
    status, subject, relative_strength, classification, subject_kind: kind, peer_set: usable.map((r) => r.symbol), sector, excluded, comparable, comparability_note: note + industryNote,
    rows: [subjectRow, ...peerRows.filter((r) => r.symbol !== subject)], comparisons, min_peers: MIN_PEERS,
    valuation_context: { available: haveVal, summary, items: valItems, token_vs_underlying: tvu, caveats },
  };
}
