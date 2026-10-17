/** Data exports (PRD Phase 2): CSV of a report's numbers and a full tenant export. */
import type { SentinelReport } from "./pipeline.js";

/** CSV cell with quoting, and a leading apostrophe on formula-looking text (CSV injection). */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/u.test(s) && Number.isNaN(Number(s))) s = `'${s}`;
  return /[",\n\r]/u.test(s) ? `"${s.replace(/"/gu, '""')}"` : s;
}
const row = (...c: unknown[]) => c.map(csvCell).join(",");

export function reportCsv(r: SentinelReport): string {
  const out: string[] = [row("section", "id", "label", "value", "unit", "status", "basis")];
  out.push(row("summary", "status", "Assessment status", r.assessment.status, "", "", r.assessment.determining_rules.join(" ")));
  for (const m of r.asset.metrics) out.push(row("metric", m.id, m.label, m.value, m.unit, m.status, m.formula));
  for (const c of r.peers.comparisons) out.push(row("peer", c.metric, c.label, c.subject, "", c.note ?? "ok", `peer_median=${c.peer_median ?? ""}; vs_median=${c.vs_median ?? ""}; percentile=${c.percentile ?? ""}; n=${c.peer_count}`));
  for (const s of r.scenarios) out.push(row("scenario", s.scenario_id, s.label, s.metrics.underlying_change ?? "", "ratio", s.status, s.status === "computed" ? s.changes.map((x) => `${x.variable}: ${x.from}->${x.to}`).join("; ") : s.reason));
  for (const k of [...r.risks.token, ...r.risks.underlying, ...r.risks.market]) out.push(row("risk", `${k.scope}:${k.category}`, k.description, "", "", k.severity, k.suggested_follow_up));
  out.push(row("hash", "calculation_hash", "Calculation hash", r.hashes.calculation_hash, "", "", ""), row("hash", "report_hash", "Report hash", r.hashes.report_hash, "", "", ""));
  return out.join("\r\n") + "\r\n";
}
