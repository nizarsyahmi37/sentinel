/**
 * Agent-commerce adapter (FR-14, PRD §13). Turns a funded ERC-8183 job (or a
 * paid x402 request) into a Sentinel analysis.
 *
 * Safety properties:
 *  - The task text is untrusted. It is only parsed as JSON and validated
 *    against the dossier schema; it can never change the payee, price or any
 *    signing behaviour (those live in signing.ts, outside this module).
 *  - A task Sentinel cannot analyse is REJECTED at negotiate time (before the
 *    buyer funds), and a failed analysis THROWS so no deliverable is
 *    submitted on-chain — a failure is never dressed up as a success.
 *  - One analysis per job id: duplicate notifications/sweeps reuse it.
 */
import { type Dossier } from "./types.js";
import { type ValidationIssue, validateDossier } from "./pipeline.js";
import { type RunnerEnv, startAnalysis } from "./runner.js";
import type { AnalysisRecord, Store, TaskRef } from "./store.js";
import { canonicalJson, shortId } from "./util.js";

export class TaskError extends Error {
  constructor(
    message: string,
    readonly issues?: ValidationIssue[],
  ) {
    super(message);
    this.name = "TaskError";
  }
}

export interface CommerceEnv extends RunnerEnv {
  tenant: string;
  /** Hold the deliverable until an analyst approves the report (PRD §21 Q3). */
  requireApproval?: boolean;
  approvalPollMs?: number;
  approvalTimeoutMs?: number;
}

/** Waits for an analyst decision; throws (so nothing is submitted on-chain) on rejection or timeout. */
export async function awaitApproval(env: CommerceEnv, analysisId: string): Promise<void> {
  const poll = env.approvalPollMs ?? 3000;
  const deadline = Date.now() + (env.approvalTimeoutMs ?? 30 * 60_000);
  for (;;) {
    const r = env.store.getAnalysis(env.tenant, analysisId);
    if (r?.review?.status === "approved") return;
    if (r?.review?.status === "changes_requested") throw new Error(`Analyst requested changes (${r.review.notes || "no notes"}); report withheld, no deliverable submitted.`);
    if (Date.now() >= deadline) throw new Error("No analyst approval before the deadline; report withheld, no deliverable submitted.");
    await new Promise((res) => setTimeout(res, poll));
  }
}

export type ParsedTask =
  | { kind: "dossier"; dossier: Dossier }
  | { kind: "asset"; asset_id: string };

/** Extract the buyer's task text from the runtime's work prompt. */
export function taskFromPrompt(prompt: string): string {
  const marker = "JOB CONTEXT:\n";
  const i = prompt.indexOf(marker);
  if (i === -1) return prompt.trim();
  const rest = prompt.slice(i + marker.length).trim();
  try {
    const ctx = JSON.parse(rest) as { task?: unknown };
    if (typeof ctx.task === "string") return ctx.task.trim();
  } catch {
    /* fall through */
  }
  return rest;
}

export function parseTask(task: string): ParsedTask {
  const t = task.trim();
  if (!t) throw new TaskError("Empty task. Provide a Sentinel dossier or \"equity:AAPL\" (see GET /api/v1/services for the input schema).");
  const eq = /^equity:([A-Za-z]{1,5})$/u.exec(t);
  if (eq) return validated({ underlying: eq[1]!.toUpperCase() });
  let obj: unknown;
  try {
    obj = JSON.parse(t);
  } catch {
    // tolerate leading prose before a JSON object
    const s = t.indexOf("{");
    const e = t.lastIndexOf("}");
    if (s === -1 || e <= s) throw new TaskError("Task is not valid JSON. Send the dossier JSON, {\"sentinel\":\"v1\",\"asset_id\":\"…\"}, or \"equity:AAPL\".");
    try {
      obj = JSON.parse(t.slice(s, e + 1));
    } catch {
      throw new TaskError("Task is not valid JSON.");
    }
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) throw new TaskError("Task must be a JSON object.");
  const o = obj as Record<string, unknown>;
  if (o.sentinel !== undefined) {
    if (o.dossier !== undefined) return validated(o.dossier);
    if (typeof o.asset_id === "string") return { kind: "asset", asset_id: o.asset_id };
    throw new TaskError('Sentinel task needs "dossier" or "asset_id".');
  }
  return validated(o);
}

function validated(input: unknown): ParsedTask {
  const v = validateDossier(input);
  if (!v.ok) throw new TaskError(`Dossier failed validation: ${v.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`, v.errors);
  return { kind: "dossier", dossier: v.dossier };
}

/** Negotiate-time check: refuse a quote for a task Sentinel can't deliver. */
export function precheckTask(task: string | undefined, store: Store, tenant: string): void {
  if (task === undefined) throw new TaskError("task_description is required.");
  const p = parseTask(task);
  if (p.kind === "asset" && !store.latestDossier(tenant, p.asset_id)) {
    throw new TaskError(`Asset "${p.asset_id}" is not registered with this Sentinel. POST /api/v1/assets first, or send the dossier inline.`);
  }
}

export function deliverablePayload(rec: AnalysisRecord) {
  const r = rec.report!;
  return {
    sentinel: {
      service_id: "sentinel.tokenized-equity-assessment",
      schema_version: r.schema_version,
      analysis_id: rec.analysis_id,
      assessment_status: r.assessment.status,
      calculation_hash: r.hashes.calculation_hash,
      report_hash: r.hashes.report_hash,
      disclaimer: r.disclaimer,
    },
    report: r,
  };
}

export type SellerWork = (prompt: string, opts: { sessionId: string; abortSignal?: AbortSignal }) => Promise<string>;

export function createSentinelWork(env: CommerceEnv): SellerWork {
  return async (prompt, { sessionId }) => {
    const { store, tenant } = env;
    const task = taskFromPrompt(prompt);
    const parsed = parseTask(task); // throws TaskError → no deliverable is submitted
    const jobId = /^\d+$/u.test(sessionId) ? sessionId : null;
    const protocol: TaskRef["protocol"] = jobId ? "erc8183" : "x402";
    const ver =
      parsed.kind === "dossier"
        ? store.putAsset(tenant, parsed.dossier, env.now()).version
        : (() => {
            const v = store.latestDossier(tenant, parsed.asset_id);
            if (!v) throw new TaskError(`Asset "${parsed.asset_id}" not found.`);
            return v;
          })();
    const taskRef: TaskRef = { protocol, job_id: jobId, tx_hash: null, deliverable_url: null, buyer: null, status: "PROCESSING", updated_at: env.now().toISOString() };
    const analysisId = jobId ? shortId("analysis", { job: jobId, t: tenant }) : undefined;
    const handle = startAnalysis(env, tenant, ver, { requestedBy: `commerce:${protocol}:${jobId ?? "x402"}`, task: taskRef, analysisId, force: false });
    const rec = await handle.done;
    if (rec.status !== "completed" || !rec.report) {
      store.updateAnalysis(tenant, rec.analysis_id, { task: { ...taskRef, status: "FAILED", error: rec.error ?? "analysis failed", updated_at: env.now().toISOString() } });
      throw new Error(`Sentinel analysis failed: ${rec.error ?? "unknown error"}`);
    }
    if (rec.report.assessment.determining_rules.includes("R-INS-1")) {
      // A paid job must not be "delivered" as an empty report because a data source was down:
      // fail it so the buyer can use the protocol's refund/expiry path.
      const msg = `Market data for ${rec.report.asset_overview.underlying} was unavailable (${rec.report.market.snapshot.limitations.join(" ") || "no price history"}); no deliverable submitted.`;
      store.updateAnalysis(tenant, rec.analysis_id, { task: { ...taskRef, status: "FAILED", error: msg, updated_at: env.now().toISOString() } });
      throw new Error(`Sentinel could not complete the job: ${msg}`);
    }
    if (env.requireApproval) {
      store.updateAnalysis(tenant, rec.analysis_id, { task: { ...(rec.task ?? taskRef), status: "AWAITING_APPROVAL", updated_at: env.now().toISOString() } });
      store.audit(tenant, { event: "awaiting_analyst_approval", analysis_id: rec.analysis_id, asset_id: rec.asset_id }, env.now());
      try {
        await awaitApproval(env, rec.analysis_id);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        store.updateAnalysis(tenant, rec.analysis_id, { task: { ...(rec.task ?? taskRef), status: "FAILED", error: msg, updated_at: env.now().toISOString() } });
        throw e;
      }
    }
    store.updateAnalysis(tenant, rec.analysis_id, { task: { ...(rec.task ?? taskRef), status: "DELIVERED", updated_at: env.now().toISOString() } });
    store.audit(tenant, { event: "commerce_delivery_prepared", analysis_id: rec.analysis_id, asset_id: rec.asset_id, detail: { protocol, job_id: jobId, report_hash: rec.report_hash } }, env.now());
    return canonicalJson(deliverablePayload(rec));
  };
}

/** Called after a successful on-chain submit so the UI can show real refs. */
export function recordSubmit(env: CommerceEnv, jobId: number, res: { submitTx: string; deliverableUrl: string | null }): void {
  const rec = env.store.findAnalysisByJob(env.tenant, String(jobId));
  if (!rec) return;
  env.store.updateAnalysis(env.tenant, rec.analysis_id, {
    task: { ...(rec.task as TaskRef), status: "SUBMITTED", tx_hash: res.submitTx, deliverable_url: res.deliverableUrl, updated_at: env.now().toISOString() },
  });
  env.store.audit(env.tenant, { event: "job_submitted_onchain", analysis_id: rec.analysis_id, asset_id: rec.asset_id, detail: { job_id: jobId, tx_hash: res.submitTx, deliverable_url: res.deliverableUrl } }, env.now());
}
