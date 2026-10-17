/**
 * Usage metrics (PRD §16): derived only from what the store really holds —
 * analyses, tasks, ledger and audit events. Anything not measurable says so.
 */
import type { AnalysisRecord, AuditEvent, LedgerEntry } from "./store.js";

const median = (x: number[]): number | null => {
  if (!x.length) return null;
  const s = [...x].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const p95 = (x: number[]): number | null => (x.length ? [...x].sort((a, b) => a - b)[Math.min(x.length - 1, Math.ceil(x.length * 0.95) - 1)]! : null);

export function usageMetrics(analyses: AnalysisRecord[], audit: AuditEvent[], ledger: LedgerEntry[], now: Date) {
  const done = analyses.filter((a) => a.status === "completed");
  const failed = analyses.filter((a) => a.status === "failed");
  const secs = done.filter((a) => a.completed_at).map((a) => (Date.parse(a.completed_at!) - Date.parse(a.created_at)) / 1000).filter((x) => x >= 0);
  const monthKey = now.toISOString().slice(0, 7);
  const thisMonth = done.filter((a) => (a.completed_at ?? "").startsWith(monthKey));
  const perAsset = new Map<string, number>();
  for (const a of done) perAsset.set(a.asset_id, (perAsset.get(a.asset_id) ?? 0) + 1);
  const repeat = [...perAsset.values()].filter((n) => n > 1).length;
  const tasks = analyses.filter((a) => a.task);
  const tasksDone = tasks.filter((a) => a.status === "completed");
  const funded = tasks.filter((a) => a.task!.protocol !== "api" && a.task!.protocol !== "demo");
  const delivered = funded.filter((a) => a.status === "completed" && ["SUBMITTED", "DELIVERED"].includes(a.task!.status));
  const sourceFailures = audit.filter((e) => e.event === "data_source_failure");
  const bySource: Record<string, number> = {};
  for (const e of sourceFailures) {
    const k = String(e.detail?.source ?? "unknown");
    bySource[k] = (bySource[k] ?? 0) + 1;
  }
  const byStatus: Record<string, number> = {};
  for (const a of done) if (a.assessment_status) byStatus[a.assessment_status] = (byStatus[a.assessment_status] ?? 0) + 1;
  const reviewed = done.filter((a) => a.review);
  return {
    generated_at: now.toISOString(),
    north_star: { name: "Verified assessments delivered this month", month: monthKey, value: thisMonth.length },
    usage: {
      assets_analyzed: perAsset.size,
      reports_delivered: done.length,
      reports_failed: failed.length,
      completion_rate: analyses.length ? done.length / analyses.length : null,
      repeat_assets: repeat,
      repeat_usage_rate: perAsset.size ? repeat / perAsset.size : null,
      by_assessment_status: byStatus,
    },
    performance: {
      time_to_report_seconds: { count: secs.length, median: median(secs), p95: p95(secs), max: secs.length ? Math.max(...secs) : null },
      target: { report_seconds: 60 },
      within_target_rate: secs.length ? secs.filter((s) => s <= 60).length / secs.length : null,
    },
    commerce: {
      agent_tasks: tasks.length,
      agent_tasks_completed: tasksDone.length,
      paid_tasks: funded.length,
      payment_to_delivery_rate: funded.length ? delivered.length / funded.length : null,
      reports_submitted_onchain: ledger.filter((l) => l.kind === "report_submitted").length,
    },
    quality: {
      analyst_reviews: reviewed.length,
      reviews_requesting_changes: reviewed.filter((a) => a.review!.status === "changes_requested").length,
      manual_corrections: audit.filter((e) => e.event === "manual_correction").length,
      data_source_failures: sourceFailures.length,
      data_source_failures_by_source: bySource,
      model_failures: audit.filter((e) => e.event === "model_failure").length,
    },
    not_measured: ["Calculation accuracy against external references", "Risk-flag precision/recall (needs labelled outcomes)", "Revenue and margin until buyers settle on-chain"],
  };
}
