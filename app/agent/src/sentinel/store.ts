/**
 * File-backed persistence (PRD §10.1.J, FR-17). One directory per tenant.
 * Writes are atomic (tmp + rename); ids are validated to prevent path
 * traversal. NOTE: on an ephemeral managed runtime the filesystem is not
 * durable — point SENTINEL_DATA_DIR at durable storage for production.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Dossier, UNIVERSE } from "./types.js";
import { hashOf, shortId } from "./util.js";
import type { WebhookRecord } from "./webhooks.js";
import type { SentinelReport } from "./pipeline.js";

const ID = /^[A-Za-z0-9_-]{1,80}$/u;

export function safeId(id: string, what = "id"): string {
  if (!ID.test(id)) throw new StoreError("invalid_id", `Invalid ${what}`);
  return id;
}

export class StoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

export interface AssetVersion {
  version: number;
  dossier_version: string;
  created_at: string;
  dossier: Dossier;
}

export interface AssetRecord {
  asset_id: string;
  versions: AssetVersion[];
}

export interface TaskRef {
  protocol: "erc8183" | "x402" | "api" | "demo";
  job_id: string | null;
  tx_hash: string | null;
  deliverable_url: string | null;
  buyer: string | null;
  status: "FUNDED" | "PROCESSING" | "AWAITING_APPROVAL" | "DELIVERED" | "FAILED" | "SUBMITTED";
  updated_at: string;
  error?: string;
}

export interface AnalysisRecord {
  analysis_id: string;
  asset_id: string;
  dossier_version: string;
  kind: "integrated_assessment";
  status: "processing" | "completed" | "failed";
  stage: string | null;
  requested_by: string;
  created_at: string;
  completed_at: string | null;
  assessment_status: string | null;
  report_hash: string | null;
  calculation_hash: string | null;
  report_version: number;
  previous_analysis_id: string | null;
  outdated: { since: string; reasons: string[] } | null;
  /** Human analyst sign-off (PRD §21 Q7). Never changes the automated status or hashes. */
  review?: { status: "approved" | "changes_requested"; reviewer: string; notes: string; at: string } | null;
  /** Analyst the report is assigned to for review. */
  assignee?: { user: string; assigned_by: string; at: string } | null;
  task: TaskRef | null;
  error: string | null;
  report: SentinelReport | null;
}

export interface MonitorRecord {
  monitor_id: string;
  analysis_id: string;
  asset_id: string;
  created_at: string;
  thresholds: unknown[];
  baseline: Record<string, number>;
  baseline_dossier_version: string;
  last_checked_at: string | null;
  alerts: unknown[];
}

export interface AuditEvent {
  at: string;
  event: string;
  tenant: string;
  analysis_id?: string;
  asset_id?: string;
  /** Authenticated user (API-key label) who triggered the event, when known. */
  actor?: string;
  detail?: Record<string, unknown>;
}

export interface LedgerEntry {
  at: string;
  kind: "llm_call" | "report_submitted";
  model?: string;
  input_tokens?: number | null;
  output_tokens?: number | null;
  /** Known only for models priced at zero (e.g. auto/free); otherwise null = unpriced. */
  cost_usd?: number | null;
  analysis_id?: string;
  job_id?: string;
  /** Price quoted for the job; revenue is only earned once the buyer settles. */
  price_usd?: string;
}

export interface SavedPortfolio {
  portfolio_id: string;
  name: string;
  holdings: { symbol: string; value_usd: number }[];
  created_at: string;
  created_by: string;
  updated_at: string;
}

export class Store {
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
  }

  private dir(tenant: string, ...parts: string[]): string {
    const d = path.join(this.root, safeId(tenant, "tenant"), ...parts);
    mkdirSync(d, { recursive: true });
    return d;
  }

  private write(file: string, data: unknown): void {
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, file);
  }

  private read<T>(file: string): T | null {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as T;
    } catch {
      return null;
    }
  }

  // ── Assets ────────────────────────────────────────────────────────────────
  getAsset(tenant: string, assetId: string): AssetRecord | null {
    return this.read<AssetRecord>(path.join(this.dir(tenant, "assets"), `${safeId(assetId, "asset_id")}.json`));
  }

  putAsset(tenant: string, dossier: Dossier, now: Date): { record: AssetRecord; version: AssetVersion; created: boolean } {
    const file = path.join(this.dir(tenant, "assets"), `${safeId(dossier.asset_id, "asset_id")}.json`);
    const rec = this.read<AssetRecord>(file) ?? { asset_id: dossier.asset_id, versions: [] };
    const dossierVersion = shortId("dos", dossier);
    const existing = rec.versions.find((v) => v.dossier_version === dossierVersion);
    if (existing && rec.versions[rec.versions.length - 1] === existing) return { record: rec, version: existing, created: false };
    const version: AssetVersion = {
      version: rec.versions.length + 1,
      dossier_version: dossierVersion,
      created_at: now.toISOString(),
      dossier,
    };
    rec.versions.push(version);
    this.write(file, rec);
    return { record: rec, version, created: true };
  }

  listAssets(tenant: string): { asset_id: string; name: string; versions: number; latest_dossier_version: string; updated_at: string }[] {
    const d = this.dir(tenant, "assets");
    const out: { asset_id: string; name: string; versions: number; latest_dossier_version: string; updated_at: string }[] = [];
    for (const f of readdirSync(d)) {
      if (!f.endsWith(".json")) continue;
      const a = this.read<AssetRecord>(path.join(d, f));
      const last = a?.versions[a.versions.length - 1];
      if (a && last) out.push({ asset_id: a.asset_id, name: UNIVERSE[last.dossier.underlying].name, versions: a.versions.length, latest_dossier_version: last.dossier_version, updated_at: last.created_at });
    }
    return out.sort((x, y) => x.asset_id.localeCompare(y.asset_id));
  }

  /** Retention/deletion (PRD §14.3): removes the asset, its analyses and monitors. The audit log is retained. */
  deleteAsset(tenant: string, assetId: string): { assets: number; analyses: number; monitors: number } {
    const id = safeId(assetId, "asset_id");
    const res = { assets: 0, analyses: 0, monitors: 0 };
    const af = path.join(this.dir(tenant, "assets"), `${id}.json`);
    if (existsSync(af)) {
      rmSync(af);
      res.assets = 1;
    }
    for (const a of this.listAnalyses(tenant, id)) {
      rmSync(path.join(this.dir(tenant, "analyses"), `${a.analysis_id}.json`), { force: true });
      res.analyses++;
    }
    for (const m of this.listMonitors(tenant).filter((x) => x.asset_id === id)) {
      rmSync(path.join(this.dir(tenant, "monitors"), `${m.monitor_id}.json`), { force: true });
      res.monitors++;
    }
    return res;
  }

  latestDossier(tenant: string, assetId: string): AssetVersion | null {
    const a = this.getAsset(tenant, assetId);
    return a ? (a.versions[a.versions.length - 1] ?? null) : null;
  }

  // ── Analyses ──────────────────────────────────────────────────────────────
  getAnalysis(tenant: string, id: string): AnalysisRecord | null {
    return this.read<AnalysisRecord>(path.join(this.dir(tenant, "analyses"), `${safeId(id, "analysis_id")}.json`));
  }

  putAnalysis(tenant: string, rec: AnalysisRecord): void {
    this.write(path.join(this.dir(tenant, "analyses"), `${safeId(rec.analysis_id, "analysis_id")}.json`), rec);
  }

  updateAnalysis(tenant: string, id: string, patch: Partial<AnalysisRecord>): AnalysisRecord {
    const cur = this.getAnalysis(tenant, id);
    if (!cur) throw new StoreError("not_found", "analysis not found");
    const next = { ...cur, ...patch };
    this.putAnalysis(tenant, next);
    return next;
  }

  listAnalyses(tenant: string, assetId?: string): AnalysisRecord[] {
    const d = this.dir(tenant, "analyses");
    const out: AnalysisRecord[] = [];
    for (const f of readdirSync(d)) {
      if (!f.endsWith(".json")) continue;
      const r = this.read<AnalysisRecord>(path.join(d, f));
      if (r && (!assetId || r.asset_id === assetId)) out.push(r);
    }
    return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  findAnalysisByJob(tenant: string, jobId: string): AnalysisRecord | null {
    return this.listAnalyses(tenant).find((a) => a.task?.job_id === jobId) ?? null;
  }

  // ── Monitors ──────────────────────────────────────────────────────────────
  getMonitor(tenant: string, id: string): MonitorRecord | null {
    return this.read<MonitorRecord>(path.join(this.dir(tenant, "monitors"), `${safeId(id, "monitor_id")}.json`));
  }

  putMonitor(tenant: string, m: MonitorRecord): void {
    this.write(path.join(this.dir(tenant, "monitors"), `${safeId(m.monitor_id, "monitor_id")}.json`), m);
  }

  listMonitors(tenant: string): MonitorRecord[] {
    const d = this.dir(tenant, "monitors");
    return readdirSync(d)
      .filter((f) => f.endsWith(".json"))
      .map((f) => this.read<MonitorRecord>(path.join(d, f)))
      .filter((x): x is MonitorRecord => x !== null);
  }

  // ── Saved portfolios ──────────────────────────────────────────────────────
  getPortfolio(tenant: string, id: string): SavedPortfolio | null {
    return this.read<SavedPortfolio>(path.join(this.dir(tenant, "portfolios"), `${safeId(id, "portfolio_id")}.json`));
  }
  putPortfolio(tenant: string, p: SavedPortfolio): void {
    this.write(path.join(this.dir(tenant, "portfolios"), `${safeId(p.portfolio_id, "portfolio_id")}.json`), p);
  }
  listPortfolios(tenant: string): SavedPortfolio[] {
    const d = this.dir(tenant, "portfolios");
    return readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => this.read<SavedPortfolio>(path.join(d, f))).filter((x): x is SavedPortfolio => x !== null).sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  deletePortfolio(tenant: string, id: string): boolean {
    const f = path.join(this.dir(tenant, "portfolios"), `${safeId(id, "portfolio_id")}.json`);
    if (!existsSync(f)) return false;
    rmSync(f);
    return true;
  }

  // ── Webhooks ──────────────────────────────────────────────────────────────
  getWebhook(tenant: string, id: string): WebhookRecord | null {
    return this.read<WebhookRecord>(path.join(this.dir(tenant, "webhooks"), `${safeId(id, "webhook_id")}.json`));
  }
  putWebhook(tenant: string, w: WebhookRecord): void {
    this.write(path.join(this.dir(tenant, "webhooks"), `${safeId(w.webhook_id, "webhook_id")}.json`), w);
  }
  listWebhooks(tenant: string): WebhookRecord[] {
    const d = this.dir(tenant, "webhooks");
    return readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => this.read<WebhookRecord>(path.join(d, f))).filter((x): x is WebhookRecord => x !== null);
  }
  deleteWebhook(tenant: string, id: string): boolean {
    const f = path.join(this.dir(tenant, "webhooks"), `${safeId(id, "webhook_id")}.json`);
    if (!existsSync(f)) return false;
    rmSync(f);
    return true;
  }

  allTenants(): string[] {
    return existsSync(this.root) ? readdirSync(this.root).filter((t) => ID.test(t)) : [];
  }

  // ── Audit (append-only) ───────────────────────────────────────────────────
  audit(tenant: string, ev: Omit<AuditEvent, "tenant" | "at">, now: Date): void {
    const line: AuditEvent = { at: now.toISOString(), tenant, ...ev };
    appendFileSync(path.join(this.dir(tenant), "audit.jsonl"), `${JSON.stringify(line)}\n`);
  }

  readAudit(tenant: string, filter?: { analysis_id?: string; asset_id?: string }): AuditEvent[] {
    const file = path.join(this.dir(tenant), "audit.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AuditEvent)
      .filter((e) => (!filter?.analysis_id || e.analysis_id === filter.analysis_id) && (!filter?.asset_id || e.asset_id === filter.asset_id));
  }

  // ── Ledger (self-funding view: revenue vs. model cost) ────────────────────
  appendLedger(entry: LedgerEntry): void {
    appendFileSync(path.join(this.root, "ledger.jsonl"), `${JSON.stringify(entry)}\n`);
  }

  readLedger(): LedgerEntry[] {
    const f = path.join(this.root, "ledger.jsonl");
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as LedgerEntry);
  }

  static contentHash(v: unknown): string {
    return hashOf(v);
  }
}
