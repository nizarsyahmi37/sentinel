/**
 * Runs and persists analyses; shared by the REST API, the commerce adapter
 * and the monitor so all three get the same idempotency, audit and honest
 * failure semantics (FR-17, NFR reliability).
 */
import type { Thresholds } from "./config.js";
import { loadThresholds } from "./config.js";
import type { FetchLike } from "./sources.js";
import { type SentinelReport, runAssessment } from "./pipeline.js";
import type { AnalysisRecord, AssetVersion, Store, TaskRef } from "./store.js";
import type { Narrate } from "./thesis.js";
import type { ScenarioConfig } from "./types.js";
import { shortId } from "./util.js";
import { type Resolver, dispatchWebhooks } from "./webhooks.js";

export interface RunnerEnv {
  store: Store;
  narrate?: Narrate;
  now: () => Date;
  fetchImpl?: FetchLike;
  offline?: boolean;
  cacheDir?: string;
  thresholds?: Thresholds;
  /** Skip peer benchmarking (no peer network calls). */
  skipPeers?: boolean;
  /** Test seams for outbound webhooks. */
  webhookPost?: Parameters<typeof dispatchWebhooks>[0]["webhookPost"];
  resolveHost?: Resolver;
}

const FAILURE = /fetch failed|RPC unavailable|unavailable|failed/iu;

/** Turns report limitations about failed sources into audit events (PRD §15 observability). */
export function recordSourceFailures(store: Store, tenant: string, now: Date, assetId: string, analysisId: string | null, limitations: string[]): number {
  let n = 0;
  for (const text of limitations) {
    if (!FAILURE.test(text) || /^Offline mode/u.test(text)) continue;
    const source = /^([^:(]+?)(?:\s*[:(]|\s+unavailable)/u.exec(text)?.[1]?.trim() ?? "unknown";
    store.audit(tenant, { event: "data_source_failure", asset_id: assetId, ...(analysisId ? { analysis_id: analysisId } : {}), detail: { source, message: text.slice(0, 300) } }, now);
    n++;
  }
  return n;
}

export interface RunOptions {
  requestedBy: string;
  scenarioConfig?: ScenarioConfig;
  overrides?: Partial<Record<string, number>>;
  force?: boolean;
  previous?: AnalysisRecord | null;
  task?: TaskRef | null;
  analysisId?: string;
}

export interface RunHandle {
  record: AnalysisRecord;
  deduped: boolean;
  done: Promise<AnalysisRecord>;
}

export function startAnalysis(env: RunnerEnv, tenant: string, ver: AssetVersion, o: RunOptions): RunHandle {
  const { store } = env;
  const prevVersion = o.previous ? o.previous.report_version : 0;
  const id =
    o.analysisId ??
    shortId("analysis", {
      t: tenant,
      a: ver.dossier.asset_id,
      d: ver.dossier_version,
      c: o.scenarioConfig ?? null,
      o: o.overrides ?? null,
      p: o.previous?.analysis_id ?? null,
      day: env.now().toISOString().slice(0, 10), // market data changes daily: a new day is a new analysis
    });
  const existing = store.getAnalysis(tenant, id);
  if (existing && !o.force && existing.status !== "failed" && !existing.outdated) {
    return { record: existing, deduped: true, done: Promise.resolve(existing) };
  }
  const created = env.now();
  const rec: AnalysisRecord = {
    analysis_id: id,
    asset_id: ver.dossier.asset_id,
    dossier_version: ver.dossier_version,
    kind: "integrated_assessment",
    status: "processing",
    stage: "queued",
    requested_by: o.requestedBy,
    created_at: created.toISOString(),
    completed_at: null,
    assessment_status: null,
    report_hash: null,
    calculation_hash: null,
    report_version: prevVersion + 1,
    previous_analysis_id: o.previous?.analysis_id ?? null,
    outdated: null,
    task: o.task ?? null,
    error: null,
    report: null,
  };
  store.putAnalysis(tenant, rec);
  store.audit(tenant, { event: "analysis_requested", analysis_id: id, asset_id: rec.asset_id, detail: { requested_by: o.requestedBy, dossier_version: ver.dossier_version, report_version: rec.report_version } }, created);

  const done = (async (): Promise<AnalysisRecord> => {
    try {
      const report: SentinelReport = await runAssessment(ver.dossier, {
        now: created,
        narrate: env.narrate,
        fetchImpl: env.fetchImpl,
        offline: env.offline,
        cacheDir: env.cacheDir,
        thresholds: env.thresholds ?? loadThresholds(),
        skipPeers: env.skipPeers,
        scenarioConfig: o.scenarioConfig,
        overrides: o.overrides,
        reportVersion: rec.report_version,
        previousAnalysisId: rec.previous_analysis_id ?? undefined,
        analysisId: id,
        onStage: (stage) => {
          try {
            store.updateAnalysis(tenant, id, { stage });
          } catch {
            /* progress is best-effort */
          }
        },
      });
      const completed = env.now();
      const next = store.updateAnalysis(tenant, id, {
        status: "completed",
        stage: "completed",
        completed_at: completed.toISOString(),
        assessment_status: report.assessment.status,
        report_hash: report.hashes.report_hash,
        calculation_hash: report.hashes.calculation_hash,
        report,
      });
      recordSourceFailures(store, tenant, completed, rec.asset_id, id, [...report.market.snapshot.limitations, ...report.peers.excluded.filter((e) => e.reason.startsWith("data")).map((e) => `Peer ${e.symbol}: ${e.reason}`)]);
      if (env.narrate && report.thesis.narrative_source === "template") {
        store.audit(tenant, { event: "model_failure", analysis_id: id, asset_id: rec.asset_id, detail: { message: report.thesis.validation_notes.join(" ").slice(0, 400), fallback: "template" } }, completed);
      }
      void dispatchWebhooks({ store, now: env.now, webhookPost: env.webhookPost, resolveHost: env.resolveHost }, tenant, "analysis.completed", { analysis_id: id, asset_id: rec.asset_id, status: report.assessment.status, report_hash: report.hashes.report_hash, calculation_hash: report.hashes.calculation_hash }).catch(() => undefined);
      store.audit(tenant, { event: "analysis_completed", analysis_id: id, asset_id: rec.asset_id, detail: { status: report.assessment.status, calculation_hash: report.hashes.calculation_hash, report_hash: report.hashes.report_hash, narrative: report.thesis.narrative_source, data_quality: report.market.snapshot.data_quality_status } }, completed);
      return next;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const failed = store.updateAnalysis(tenant, id, { status: "failed", stage: "failed", error: msg, completed_at: env.now().toISOString() });
      void dispatchWebhooks({ store, now: env.now, webhookPost: env.webhookPost, resolveHost: env.resolveHost }, tenant, "analysis.failed", { analysis_id: id, asset_id: rec.asset_id, error: msg }).catch(() => undefined);
      store.audit(tenant, { event: "analysis_failed", analysis_id: id, asset_id: rec.asset_id, detail: { error: msg } }, env.now());
      return failed;
    }
  })();
  return { record: rec, deduped: false, done };
}
