/**
 * Monitoring (FR-16). Compares a fresh market snapshot (or a controlled
 * test-data change) against the baseline of a delivered assessment and marks
 * the prior assessment as potentially outdated when a configured threshold is
 * crossed. It observes only data Sentinel can actually retrieve.
 */
import type { MonitoringThreshold, SentinelReport } from "./pipeline.js";
import type { MarketSnapshot } from "./types.js";
import { daysBetween } from "./stats.js";
import { round, shortId } from "./util.js";

export interface MonitorAlert {
  alert_id: string;
  threshold_id: string;
  metric: string;
  label: string;
  source: string;
  observed_at: string;
  baseline: number | null;
  current: number | null;
  change: number | null;
  change_unit: string;
  triggered: boolean;
  simulated: boolean;
  affects: MonitoringThreshold["affects"];
  affected_assumptions: string[];
  note: string;
}

/** Values Sentinel derives from a snapshot (not raw observations): drawdown, token premium, evidence age. */
export const DERIVED_KEYS = ["drawdown_from_high", "token_premium", "fundamentals_age_days", "feed_age_days"] as const;

export function derivedValues(s: MarketSnapshot, tokensPerShare: number | null, now: Date): Record<string, number> {
  const out: Record<string, number> = {};
  const adj = s.facts.bars.slice(-252).map((b) => b.adj);
  if (adj.length >= 60) out.drawdown_from_high = round(1 - adj[adj.length - 1]! / Math.max(...adj), 6);
  const last = s.facts.bars.length ? s.facts.bars[s.facts.bars.length - 1]!.close : null;
  const feed = s.facts.token?.feed;
  if (feed && last && tokensPerShare) {
    out.token_premium = round(feed.answer / (last / tokensPerShare) - 1, 6);
    out.feed_age_days = round((now.getTime() / 1000 - feed.updated_at) / 86_400, 3);
  }
  const filed = s.facts.fundamentals?.latest_filed;
  if (filed) out.fundamentals_age_days = daysBetween(filed, now.toISOString().slice(0, 10));
  return out;
}

export function baselineFromReport(r: SentinelReport): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of r.market.snapshot.metrics) out[m.key] = m.value;
  return { ...out, ...derivedValues(r.market.snapshot, r.asset_overview.token?.tokens_per_share ?? null, new Date(r.market.snapshot.observed_at)) };
}

export function evaluateThresholds(opts: {
  thresholds: MonitoringThreshold[];
  baseline: Record<string, number>;
  baselineDossierVersion: string;
  currentDossierVersion: string;
  snapshot: MarketSnapshot;
  tokensPerShare?: number | null;
  now?: Date;
}): MonitorAlert[] {
  const alerts: MonitorAlert[] = [];
  const derived = derivedValues(opts.snapshot, opts.tokensPerShare ?? null, opts.now ?? new Date(opts.snapshot.observed_at));
  for (const t of opts.thresholds) {
    if (t.metric === "dossier_version") {
      const changed = opts.currentDossierVersion !== opts.baselineDossierVersion;
      alerts.push({
        alert_id: shortId("alert", { t: t.threshold_id, v: opts.currentDossierVersion }),
        threshold_id: t.threshold_id, metric: t.metric, label: t.label, source: "asset store",
        observed_at: new Date(0).toISOString(), baseline: null, current: null, change: null, change_unit: "version",
        triggered: changed, simulated: false, affects: t.affects, affected_assumptions: t.affected_assumptions,
        note: changed ? `Dossier changed (${opts.baselineDossierVersion} → ${opts.currentDossierVersion}).` : "Dossier unchanged.",
      });
      continue;
    }
    if ((DERIVED_KEYS as readonly string[]).includes(t.metric)) {
      const cur = derived[t.metric];
      const base = opts.baseline[t.metric];
      if (cur === undefined) {
        alerts.push({ alert_id: shortId("alert", { t: t.threshold_id, none: true }), threshold_id: t.threshold_id, metric: t.metric, label: t.label, source: "unavailable", observed_at: opts.snapshot.observed_at, baseline: base ?? null, current: null, change: null, change_unit: "absolute", triggered: false, simulated: false, affects: t.affects, affected_assumptions: t.affected_assumptions, note: "Current observation unavailable; threshold not evaluated." });
        continue;
      }
      const delta = base === undefined ? null : round(cur - base, 6);
      const triggered = t.kind === "level" ? cur >= t.trigger - 1e-12 : delta !== null && (t.direction === "up" ? delta >= t.trigger - 1e-12 : t.direction === "down" ? -delta >= t.trigger - 1e-12 : Math.abs(delta) >= t.trigger - 1e-12);
      alerts.push({ alert_id: shortId("alert", { t: t.threshold_id, v: cur }), threshold_id: t.threshold_id, metric: t.metric, label: t.label, source: "derived from market snapshot", observed_at: opts.snapshot.observed_at, baseline: base ?? null, current: cur, change: t.kind === "level" ? cur : delta, change_unit: "absolute", triggered, simulated: false, affects: t.affects, affected_assumptions: t.affected_assumptions, note: t.note });
      continue;
    }
    const m = opts.snapshot.metrics.find((x) => x.key === t.metric);
    const base = opts.baseline[t.metric];
    if (!m || base === undefined) {
      alerts.push({
        alert_id: shortId("alert", { t: t.threshold_id, none: true }),
        threshold_id: t.threshold_id, metric: t.metric, label: t.label, source: "unavailable",
        observed_at: opts.snapshot.observed_at, baseline: base ?? null, current: null, change: null,
        change_unit: t.kind === "percent" ? "percent" : "absolute", triggered: false, simulated: false,
        affects: t.affects, affected_assumptions: t.affected_assumptions,
        note: "Current observation unavailable; threshold not evaluated.",
      });
      continue;
    }
    const abs = round(m.value - base, 6);
    const pctChange = base !== 0 ? round(((m.value - base) / Math.abs(base)) * 100, 4) : null;
    let triggered = false;
    let change: number | null = abs;
    if (t.kind === "percent") {
      change = pctChange;
      triggered = pctChange !== null && (t.direction === "down" ? -pctChange >= t.trigger : t.direction === "up" ? pctChange >= t.trigger : Math.abs(pctChange) >= t.trigger);
    } else {
      triggered = t.direction === "up" ? abs >= t.trigger - 1e-12 && abs > 0 : t.direction === "down" ? -abs >= t.trigger - 1e-12 : Math.abs(abs) >= t.trigger - 1e-12;
    }
    alerts.push({
      alert_id: shortId("alert", { t: t.threshold_id, v: m.value, at: m.observed_at }),
      threshold_id: t.threshold_id, metric: t.metric, label: t.label,
      source: opts.snapshot.sources.find((s) => s.source_id === m.source_id)?.name ?? m.source_id,
      observed_at: m.observed_at, baseline: base, current: m.value, change,
      change_unit: t.kind === "percent" ? "percent" : "absolute", triggered,
      simulated: m.source_id === "simulation_override", affects: t.affects,
      affected_assumptions: t.affected_assumptions, note: t.note,
    });
  }
  return alerts;
}
