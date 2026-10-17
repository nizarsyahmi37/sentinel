/**
 * Sentinel REST API (FR-15) — versioned under /api/v1, with optional API-key
 * auth (tenant isolation), per-caller rate limiting, and honest error codes.
 */
import { createHash } from "node:crypto";
import express, { type NextFunction, type Request, type Response, Router } from "express";
import { zodToJsonSchema } from "zod-to-json-schema";
import { DocumentError, ingestDocument } from "./documents.js";
import { type MonitorAlert, baselineFromReport, evaluateThresholds } from "./monitor.js";
import { buildMarketSnapshot } from "./market.js";
import { computeAll, deriveMonitoringThresholds, marketInvalidation, runAssessment, validateDossier, type SentinelReport } from "./pipeline.js";
import { type RunnerEnv, recordSourceFailures as recordFailures, startAnalysis } from "./runner.js";
import { StoreError, type AnalysisRecord, type LedgerEntry, type MonitorRecord, type TaskRef } from "./store.js";
import { renderReportBody, renderReportHtml, REPORT_CSS } from "./reportHtml.js";
import { realDocsCase } from "./issuerDocs.js";
import { deliverableUrls, listProviderJobs, readJob, summarizeDeliverable } from "./jobs.js";
import { type Hirer, isLoopback } from "./hire.js";
import { defaultFetch } from "./sources.js";
import { demoDossier, evidenceCaseDossier } from "./demo.js";
import { DOCUMENT_KINDS, DossierSchema, ScenarioConfigSchema, SYMBOLS, UNIVERSE, isSymbol, type Dossier } from "./types.js";
import { METHODOLOGY_VERSION, round, shortId } from "./util.js";
import { loadThresholds } from "./config.js";
import { KNOWN_TOKENS, TOKEN_REGISTRY_PROVENANCE } from "./knownTokens.js";
import { buildOpenApi } from "./openapi.js";
import { CHAIN_IDS } from "./chains.js";
import { OidcError, type OidcVerifier, looksLikeJwt } from "./oidc.js";
import { WEBHOOK_EVENTS, assertSafeWebhookUrl, dispatchWebhooks, newWebhookSecret, type Resolver, type WebhookRecord } from "./webhooks.js";
import { fetchEtfHoldings } from "./holdings.js";
import { type Principal, type Role, canDo, parseApiKeys, requiredRole, sha256 } from "./auth.js";
import { billingStatement, loadPriceBook } from "./billing.js";
import { reportCsv } from "./exports.js";
import { usageMetrics } from "./usage.js";
import { analyzePortfolio, fetchEtfData, fetchHoldingBars, parseHoldings } from "./portfolio.js";
import { z } from "zod";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues?: unknown,
  ) {
    super(message);
  }
}

export interface ServiceInfo {
  price_usd: string;
  assets: string[];
  network: string;
  agent_address: string | null;
  agent_id: string | null;
  agent_url: string | null;
  identity_tx: string | null;
  protocols: string[];
  rails: string[];
}

export interface ApiDeps extends RunnerEnv {
  serviceInfo: () => ServiceInfo;
  apiKeys?: string[];
  rateLimitPerMinute?: number;
  requireAuth?: boolean;
  oidc?: OidcVerifier | null;
  /** Withhold unapproved reports from viewers (SENTINEL_REQUIRE_APPROVAL=1). */
  requireApproval?: boolean;
  webhookPost?: Parameters<typeof dispatchWebhooks>[0]["webhookPost"];
  resolveHost?: Resolver;
  /** Local-only demo buyer; absent unless SENTINEL_HIRE_BUYER_DIR is configured. */
  hirer?: Hirer | null;
}

type Req = Request & { tenant?: string; caller?: string; user?: string; role?: Role };

export const ERROR_CODES = {
  invalid_request: "Malformed request body or parameters.",
  validation_failed: "The dossier failed validation; see issues[].",
  unauthorized: "Missing or invalid API key.",
  forbidden: "The API key's role does not allow this operation.",
  rate_limited: "Too many requests; retry after the indicated delay.",
  not_found: "The requested resource does not exist for this tenant.",
  conflict: "The request conflicts with current state.",
  analysis_failed: "The analysis could not be completed; no partial result is presented as complete.",
  unsupported_type: "Unsupported document type.",
  too_large: "Upload too large.",
  internal: "Unexpected server error.",
} as const;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function reportOf(rec: AnalysisRecord): SentinelReport {
  if (rec.status !== "completed" || !rec.report) throw new ApiError(409, "conflict", `Analysis is ${rec.status}; no report available.`);
  return rec.report;
}

export function compareReports(a: SentinelReport, b: SentinelReport) {
  const mv = (r: SentinelReport) => Object.fromEntries(r.asset.metrics.map((m) => [m.id, m.status === "OK" ? m.value : null]));
  const ma = mv(a);
  const mb = mv(b);
  const ids = [...new Set([...Object.keys(ma), ...Object.keys(mb)])];
  const riskIds = (r: SentinelReport) => new Set([...r.risks.token, ...r.risks.underlying, ...r.risks.market].map((x) => `${x.scope}:${x.category}:${x.severity}`));
  const ra = riskIds(a);
  const rb = riskIds(b);
  const mkt = (r: SentinelReport) => Object.fromEntries(r.market.snapshot.metrics.map((m) => [m.key, m.value]));
  const sa = mkt(a);
  const sb = mkt(b);
  return {
    from: a.report_id,
    to: b.report_id,
    status: { from: a.assessment.status, to: b.assessment.status, changed: a.assessment.status !== b.assessment.status },
    determining_rules: { from: a.assessment.determining_rules, to: b.assessment.determining_rules },
    metrics: ids.map((id) => ({
      id,
      from: ma[id] ?? null,
      to: mb[id] ?? null,
      delta: typeof ma[id] === "number" && typeof mb[id] === "number" ? round((mb[id] as number) - (ma[id] as number)) : null,
    })).filter((m) => m.from !== m.to),
    market: Object.keys({ ...sa, ...sb }).map((k) => ({ metric: k, from: sa[k] ?? null, to: sb[k] ?? null })).filter((m) => m.from !== m.to),
    new_risks: [...rb].filter((x) => !ra.has(x)),
    resolved_risks: [...ra].filter((x) => !rb.has(x)),
    inputs: {
      dossier_version: { from: a.inputs.dossier_version, to: b.inputs.dossier_version },
      market_snapshot_id: { from: a.inputs.market_snapshot_id, to: b.inputs.market_snapshot_id },
    },
  };
}

const AssessmentRequest = z
  .object({
    asset_id: z.string().min(1).max(64),
    scenario_config: ScenarioConfigSchema.optional(),
    overrides: z.record(z.string(), z.number()).optional(),
    wait: z.boolean().optional(),
    force: z.boolean().optional(),
  })
  .strict();

const DocUpload = z
  .object({
    doc_id: z.string().regex(/^[A-Za-z0-9_-]{1,60}$/u),
    title: z.string().max(200).optional(),
    kind: z.enum(DOCUMENT_KINDS),
    filename: z.string().max(200),
    content_base64: z.string().optional(),
    text: z.string().max(400_000).optional(),
  })
  .strict();

export function serviceCatalog(info: ServiceInfo) {
  const dossierSchema = zodToJsonSchema(DossierSchema, { name: "SentinelDossier", $refStrategy: "none" });
  return {
    service_id: "sentinel.tokenized-equity-assessment",
    version: "2.0.0",
    methodology_version: METHODOLOGY_VERSION,
    name: "Tokenized Stock / ETF Market Intelligence and RWA Underwriting Report",
    description:
      "Assesses a tokenized US stock or ETF on BNB Chain: real market data for the underlying (Yahoo Finance prices, FRED rates, SEC EDGAR filings), the token contract read directly from the chain, the issuer's custody/backing/redemption claims checked against evidence, stress scenarios, and a rule-based status (INSUFFICIENT_DATA / NEEDS_REVIEW / CONDITIONAL_PASS / DO_NOT_PROCEED). Decision support only.",
    asset_classes: ["tokenized_equity"],
    supported_underlyings: SYMBOLS.map((s) => ({ symbol: s, name: UNIVERSE[s].name, kind: UNIVERSE[s].kind })),
    supported_chains: CHAIN_IDS,
    price: { amount_usd: info.price_usd, fixed: true, assets: info.assets, network: info.network },
    payment_rails: info.rails,
    protocols: info.protocols,
    input: {
      description: 'Pass a dossier as the job task: the dossier JSON, {"sentinel":"v1","dossier":{...}}, {"sentinel":"v1","asset_id":"…"} for a registered asset, or "equity:AAPL" for an underlying-only assessment.',
      schema: dossierSchema,
      example_alias: "equity:NVDA — underlying-only assessment of NVDA using real market data (no token wrapper)",
    },
    output: {
      format: "application/json",
      schema_version: "sentinel.report.v2",
      sections: ["executive_summary", "asset_overview", "market", "asset.metrics", "evidence", "scenarios", "risks", "risk_coverage", "assessment", "thesis", "invalidation_conditions", "missing_information_checklist", "monitoring", "methodology", "limitations", "hashes"],
      integrity: "hashes.calculation_hash covers all deterministic content; hashes.report_hash covers the full report. Hashes show a version changed, not that facts are correct.",
    },
    data_sources: ["Yahoo Finance chart API (unofficial, delayed)", "FRED (St. Louis Fed)", "SEC EDGAR XBRL company facts", "BNB Chain JSON-RPC (read-only)"],
    completion_criteria: ["The dossier passes schema validation.", "The report is generated and carries both hashes.", "A failed analysis returns an explicit error and never a partial report presented as complete."],
    task_lifecycle: "REQUESTED → FUNDED → PROCESSING → DELIVERED → SETTLED (follows the selected protocol's semantics)",
    error_codes: ERROR_CODES,
    data_retention: "Dossiers and reports are retained for the tenant until deleted by the operator; documents are never written on-chain or sent to a model.",
    limits: { max_documents: 50, max_upload_mb: 5, typical_latency: "5–30 seconds (live data fetches; longer if a language model narrates)" },
    identity: { agent_id: info.agent_id, agent_address: info.agent_address, endpoint: info.agent_url, registration_tx: info.identity_tx, note: "Identity registration does not verify the correctness of any analysis." },
    api: { base: "/api/v1", spec: ["POST /assets", "GET /assets", "GET /assets/{id}", "POST /market-intelligence", "POST /token-verification", "POST /investment-assessment", "GET /analyses/{id}", "GET /analyses/{id}/report", "GET /services", "GET /health"] },
  };
}

export function createApi(deps: ApiDeps): Router {
  const { store } = deps;
  const router = Router();
  const windows = new Map<string, number[]>();
  const limit = deps.rateLimitPerMinute ?? 120;
  const { keys, errors: keyErrors } = parseApiKeys(deps.apiKeys ?? []);
  for (const e of keyErrors) console.warn(`[sentinel] API key config: ${e}`);

  router.use((req, res, next) => {
    const rid = /^[A-Za-z0-9_-]{8,64}$/u.test(req.get("x-request-id") ?? "") ? (req.get("x-request-id") as string) : shortId("req", [Date.now(), Math.random()]);
    res.setHeader("x-request-id", rid);
    const t0 = Date.now();
    res.on("finish", () => {
      if (process.env.SENTINEL_ACCESS_LOG !== "0") console.log(JSON.stringify({ at: "sentinel.api", request_id: rid, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - t0 }));
    });
    next();
  });

  router.use(express.json({ limit: "8mb" }));

  // Rate limit + auth (health and services are public).
  router.use(async (rq, res, next) => {
    const req = rq as Req;
    const ip = req.ip ?? "unknown";
    const bearer = /^Bearer\s+(.+)$/iu.exec(req.get("authorization") ?? "")?.[1] ?? req.get("x-api-key") ?? "";
    const open = keys.size === 0 && !deps.oidc;
    const publicPath = req.path === "/health" || req.path === "/services" || req.path === "/auth/config" || req.path === "/openapi.json";
    let principal: Principal | undefined = bearer ? keys.get(sha256(bearer)) : undefined;
    if (!principal && bearer && deps.oidc && looksLikeJwt(bearer)) {
      try {
        principal = await deps.oidc.verify(bearer);
      } catch (e) {
        if (!publicPath) return next(new ApiError(401, "unauthorized", e instanceof OidcError ? `Token rejected: ${e.message}.` : "Token could not be verified."));
      }
    }
    if (!open && !publicPath && !principal) return next(new ApiError(401, "unauthorized", "Provide a valid API key as 'Authorization: Bearer <key>'."));
    if (open && deps.requireAuth && !publicPath) return next(new ApiError(401, "unauthorized", "API keys are required but none are configured."));
    const who: Principal = principal ?? { tenant: "public", role: "admin", user: "anonymous" };
    if (!publicPath && !canDo(who.role, requiredRole(req.method, req.path))) return next(new ApiError(403, "forbidden", `Role "${who.role}" cannot ${req.method} ${req.path}; requires "${requiredRole(req.method, req.path)}".`));
    req.tenant = who.tenant;
    req.user = who.user;
    req.role = who.role;
    req.caller = `${req.tenant}:${req.user}:${ip}`;
    res.setHeader("x-sentinel-auth", open ? "open-development-mode" : principal && !keys.has(sha256(bearer)) ? "oidc" : "api-key");
    const nowMs = Date.now();
    const arr = (windows.get(req.caller) ?? []).filter((t) => nowMs - t < 60_000);
    if (arr.length >= limit) {
      res.setHeader("retry-after", "30");
      return next(new ApiError(429, "rate_limited", `Rate limit of ${limit}/min exceeded.`));
    }
    arr.push(nowMs);
    windows.set(req.caller, arr);
    next();
  });

  const tenant = (req: Request): string => (req as Req).tenant ?? "public";
  const now = () => deps.now();
  const audit = (req: Request, ev: Parameters<typeof store.audit>[1], t: Date = now()): void => store.audit(tenant(req), { ...ev, actor: (req as Req).user }, t);
  const recordSourceFailures = (tenantId: string, assetId: string, analysisId: string | null, limitations: string[], extra: string[] = []) =>
    recordFailures(store, tenantId, now(), assetId, analysisId, [...limitations, ...extra]);

  /** Approval gate: viewers only see reports an analyst has approved (when enabled). */
  const gate = (req: Request, rec: AnalysisRecord) => {
    if (deps.requireApproval && (req as Req).role === "viewer" && rec.status === "completed" && rec.review?.status !== "approved")
      throw new ApiError(403, "approval_required", "This report has not been approved by an analyst yet.");
  };

  const loadDossier = (req: Request, assetId: string) => {
    const ver = store.latestDossier(tenant(req), assetId);
    if (!ver) throw new ApiError(404, "not_found", `Asset "${assetId}" not found.`);
    return ver;
  };

  // ── Health & services ───────────────────────────────────────────────────
  router.get("/health", (_req, res) => {
    let storeOk = true;
    try {
      store.allTenants();
    } catch {
      storeOk = false;
    }
    res.json({ status: storeOk ? "ok" : "degraded", service: "sentinel", methodology_version: METHODOLOGY_VERSION, time: now().toISOString(), store: storeOk ? "ok" : "unavailable", language_model: deps.narrate ? "configured" : "not_configured (template narrative)", market_mode: deps.offline ? "offline" : "live", simulation_allowed: process.env.SENTINEL_ALLOW_SIMULATION === "1" });
  });
  router.get("/openapi.json", (_req, res) => res.json(buildOpenApi()));
  router.get("/auth/config", (_req, res) => res.json({ api_keys: keys.size > 0, oidc: deps.oidc ? { issuer: deps.oidc.cfg.issuer, audience: deps.oidc.cfg.audience, tenant_claim: deps.oidc.cfg.tenantClaim, role_claim: deps.oidc.cfg.roleClaim, algorithms: ["RS256"] } : null, approval_required: Boolean(deps.requireApproval) }));
  router.get("/me", (req, res) => res.json({ tenant: tenant(req), user: (req as Req).user, role: (req as Req).role, auth: keys.size ? "api-key" : "open-development-mode" }));
  router.get("/billing/usage", (req, res) => {
    const month = String(req.query.month ?? now().toISOString().slice(0, 7));
    if (!/^\d{4}-\d{2}$/u.test(month)) throw new ApiError(422, "invalid_request", "month must be YYYY-MM.");
    res.json(billingStatement(tenant(req), month, store.listAnalyses(tenant(req)), store.readAudit(tenant(req)), loadPriceBook(deps.serviceInfo().price_usd)));
  });
  router.get("/services", (_req, res) => res.json({ services: [serviceCatalog(deps.serviceInfo())] }));

  // ── Assets ──────────────────────────────────────────────────────────────
  router.post("/assets", (req, res) => {
    const v = validateDossier(req.body);
    if (!v.ok) throw new ApiError(422, "validation_failed", "The dossier failed validation.", v.errors);
    const { record, version, created } = store.putAsset(tenant(req), v.dossier, now());
    audit(req, { event: created ? "asset_version_created" : "asset_resubmitted_unchanged", asset_id: v.dossier.asset_id, detail: { version: version.version, dossier_version: version.dossier_version } }, now());
    res.status(created ? 201 : 200).json({
      asset_id: v.dossier.asset_id, version: version.version, dossier_version: version.dossier_version, unchanged: !created,
      versions: record.versions.length, critical_missing_inputs: v.critical_missing, optional_missing_inputs: v.optional_missing,
      ready_for_assessment: v.critical_missing.length === 0,
    });
  });

  router.get("/assets/:assetId", (req, res) => {
    const a = store.getAsset(tenant(req), String(req.params.assetId));
    if (!a) throw new ApiError(404, "not_found", "Asset not found.");
    const latest = a.versions[a.versions.length - 1]!;
    const full = req.query.full === "1";
    const strip = (d: Dossier): Dossier => (full ? d : { ...d, documents: d.documents.map((x) => ({ ...x, text: x.text ? `[${x.text.length} chars omitted; use ?full=1]` : undefined })) });
    res.json({
      asset_id: a.asset_id,
      versions: a.versions.map((v) => ({ version: v.version, dossier_version: v.dossier_version, created_at: v.created_at })),
      latest: { version: latest.version, dossier_version: latest.dossier_version, dossier: strip(latest.dossier) },
      analyses: store.listAnalyses(tenant(req), a.asset_id).map(summary),
    });
  });

  router.get("/assets", (req, res) => {
    res.json({ assets: store.listAssets(tenant(req)) });
  });

  router.delete("/assets/:assetId", (req, res) => {
    const id = String(req.params.assetId);
    if (!store.getAsset(tenant(req), id)) throw new ApiError(404, "not_found", "Asset not found.");
    const removed = store.deleteAsset(tenant(req), id);
    audit(req, { event: "asset_deleted", asset_id: id, detail: removed }, now());
    res.json({ asset_id: id, deleted: removed, note: "Dossier versions, analyses and monitors were deleted. The audit log is retained." });
  });

  // ── Documents (FR-04) ───────────────────────────────────────────────────
  router.post("/assets/:assetId/documents", async (req, res) => {
    const ver = loadDossier(req, String(req.params.assetId));
    const p = DocUpload.safeParse(req.body);
    if (!p.success) throw new ApiError(422, "invalid_request", "Invalid upload.", p.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    try {
      const out = await ingestDocument(p.data);
      const docs = [...ver.dossier.documents.filter((d) => d.doc_id !== out.document.doc_id), out.document];
      const next = { ...ver.dossier, documents: docs };
      const chk = validateDossier(next);
      if (!chk.ok) throw new ApiError(422, "validation_failed", "Resulting dossier is invalid.", chk.errors);
      const saved = store.putAsset(tenant(req), chk.dossier, now());
      audit(req, { event: "document_ingested", asset_id: ver.dossier.asset_id, detail: { doc_id: out.document.doc_id, readable: out.document.readable, version: saved.version.version } }, now());
      res.status(201).json({ ...out.summary, dossier_version: saved.version.dossier_version, version: saved.version.version });
    } catch (e) {
      if (e instanceof DocumentError) throw new ApiError(e.code === "too_large" ? 413 : 422, e.code === "unsupported_type" ? "unsupported_type" : e.code === "too_large" ? "too_large" : "invalid_request", e.message);
      throw e;
    }
  });

  router.post("/assets/:assetId/documents/:docId/corrections", (req, res) => {
    const ver = loadDossier(req, String(req.params.assetId));
    const p = z.object({ field: z.string().min(1).max(60), value: z.number().finite(), location: z.string().max(80).optional(), corrected_by: z.string().min(1).max(80), reason: z.string().min(3).max(300) }).strict().safeParse(req.body);
    if (!p.success) throw new ApiError(422, "invalid_request", "Invalid correction.", p.error.issues);
    const doc = ver.dossier.documents.find((d) => d.doc_id === req.params.docId);
    if (!doc) throw new ApiError(404, "not_found", "Document not found.");
    const extracted = [...(doc.extracted ?? []).filter((c) => !(c.field === p.data.field && c.method === "manual_correction")), { field: p.data.field, value: p.data.value, location: `${p.data.location ?? "manual correction"} — by ${p.data.corrected_by}: ${p.data.reason}`.slice(0, 200), method: "manual_correction" as const }];
    const next = { ...ver.dossier, documents: ver.dossier.documents.map((d) => (d.doc_id === doc.doc_id ? { ...d, extracted } : d)) };
    const chk = validateDossier(next);
    if (!chk.ok) throw new ApiError(422, "validation_failed", "Resulting dossier is invalid.", chk.errors);
    const saved = store.putAsset(tenant(req), chk.dossier, now());
    audit(req, { event: "manual_correction", asset_id: ver.dossier.asset_id, detail: { doc_id: doc.doc_id, field: p.data.field, value: p.data.value, corrected_by: p.data.corrected_by, reason: p.data.reason } }, now());
    res.json({ dossier_version: saved.version.dossier_version, version: saved.version.version, note: "Corrected value supersedes pattern-extracted values for this field in this document. It is still not independently verified." });
  });

  // ── Market intelligence (real data for the underlying + rates) ─────────
  router.post("/market-intelligence", async (req, res) => {
    const b = z.object({ asset_id: z.string().optional(), underlying: z.string().refine(isSymbol, { message: "not a supported underlying" }).optional(), overrides: z.record(z.string(), z.number()).optional() }).strict().safeParse(req.body);
    if (!b.success) throw new ApiError(422, "invalid_request", "Invalid request.", b.error.issues);
    if (!b.data.asset_id && !b.data.underlying) throw new ApiError(422, "invalid_request", "Provide asset_id or underlying.");
    const t = now();
    const dossier: Dossier = b.data.asset_id ? loadDossier(req, b.data.asset_id).dossier : DossierSchema.parse({ underlying: b.data.underlying });
    const parts = await computeAll(dossier, { now: t, fetchImpl: deps.fetchImpl, offline: deps.offline, cacheDir: deps.cacheDir, overrides: b.data.overrides, thresholds: deps.thresholds, skipPeers: deps.skipPeers });
    audit(req, { event: "market_intelligence_requested", asset_id: dossier.asset_id, detail: { snapshot: parts.snapshot.snapshot_id, quality: parts.snapshot.data_quality_status } }, t);
    res.json({
      snapshot: parts.snapshot, analysis: parts.market, peers: parts.peers, attractiveness: parts.market.attractiveness, risks: parts.risks.market,
      metrics: parts.metrics.filter((m) => m.group !== "token"), scenarios: parts.scenarios.filter((s) => !s.scenario_id.startsWith("token_") && !s.scenario_id.startsWith("combined")),
      thesis_invalidation: marketInvalidation({ thresholds: deriveMonitoringThresholds(parts) }).map((x) => x.condition),
    });
  });

  // ── Token verification (on-chain facts vs claims) and underlying detail ──
  const tokenVerification = async (req: Req, res: Response) => {
    const b = z.object({ asset_id: z.string(), scenario_config: ScenarioConfigSchema.optional() }).strict().safeParse(req.body);
    if (!b.success) throw new ApiError(422, "invalid_request", "Invalid request.", b.error.issues);
    const ver = loadDossier(req, b.data.asset_id);
    const parts = await computeAll(ver.dossier, { now: now(), fetchImpl: deps.fetchImpl, offline: deps.offline, cacheDir: deps.cacheDir, scenarioConfig: b.data.scenario_config, thresholds: deps.thresholds, skipPeers: true });
    audit(req, { event: "token_verification_requested", asset_id: ver.dossier.asset_id, detail: { dossier_version: ver.dossier_version } }, now());
    res.json({
      asset_id: ver.dossier.asset_id, dossier_version: ver.dossier_version, methodology_version: METHODOLOGY_VERSION,
      token: parts.snapshot.facts.token, metrics: parts.metrics, scenarios: parts.scenarios, evidence: parts.evidence, risks: parts.risks,
      missing_information_checklist: parts.evidence.checklist,
      note: "Verification only; use /investment-assessment for the integrated, rule-based status.",
    });
  };
  router.post("/token-verification", tokenVerification);
  // PRD FR-15 names this endpoint "underwriting"; kept as an alias.
  router.post("/underwriting", tokenVerification);

  // ── Peer benchmarking and valuation context (FR-07) ────────────────────
  router.post("/peers", async (req, res) => {
    const b = z.object({ asset_id: z.string().optional(), underlying: z.string().refine(isSymbol, { message: "not a supported underlying" }).optional() }).strict().safeParse(req.body);
    if (!b.success) throw new ApiError(422, "invalid_request", "Invalid request.", b.error.issues);
    if (!b.data.asset_id && !b.data.underlying) throw new ApiError(422, "invalid_request", "Provide asset_id or underlying.");
    const dossier: Dossier = b.data.asset_id ? loadDossier(req, b.data.asset_id).dossier : DossierSchema.parse({ underlying: b.data.underlying });
    const parts = await computeAll(dossier, { now: now(), fetchImpl: deps.fetchImpl, offline: deps.offline, cacheDir: deps.cacheDir, thresholds: deps.thresholds });
    recordSourceFailures(tenant(req), dossier.asset_id, null, parts.snapshot.limitations, parts.peers.excluded.filter((e) => e.reason.startsWith("data")).map((e) => `${e.symbol}: ${e.reason}`));
    audit(req, { event: "peers_requested", asset_id: dossier.asset_id, detail: { status: parts.peers.status } });
    res.json({ asset_id: dossier.asset_id, snapshot_id: parts.snapshot.snapshot_id, peers: parts.peers });
  });

  router.get("/token-registry", (req, res) => {
    const u = req.query.underlying ? String(req.query.underlying).toUpperCase() : null;
    const c = req.query.chain ? String(req.query.chain) : null;
    res.json({ tokens: KNOWN_TOKENS.filter((t) => (!u || t.underlying === u) && (!c || t.chain === c)), provenance: TOKEN_REGISTRY_PROVENANCE });
  });
  router.get("/etf-holdings/:symbol", async (req, res) => {
    const sym = String(req.params.symbol).toUpperCase();
    if (!isSymbol(sym) || UNIVERSE[sym]!.kind !== "etf") throw new ApiError(404, "not_found", "Not a supported ETF.");
    try {
      const h = await fetchEtfHoldings(sym, deps.fetchImpl);
      res.json({ ...h, holdings: h.holdings.slice(0, Math.min(500, Number(req.query.limit) || 50)), note: "Issuer-published daily holdings file; weights as published." });
    } catch (e) {
      throw new ApiError(502, "internal", `Holdings unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  // ── Saved portfolios ──────────────────────────────────────────────────
  const Holdings = z.array(z.object({ symbol: z.string().min(1).max(10), value_usd: z.number().finite() }).strict()).min(1).max(20);
  router.post("/portfolios", (req, res) => {
    const b = z.object({ name: z.string().min(1).max(80), holdings: Holdings }).strict().safeParse(req.body);
    if (!b.success) throw new ApiError(422, "invalid_request", "Invalid portfolio.", b.error.issues);
    const parsed = parseHoldings(b.data.holdings);
    if (!parsed.ok) throw new ApiError(422, "invalid_request", parsed.error);
    const id = shortId("pf", { t: tenant(req), n: b.data.name.toLowerCase() });
    const prev = store.getPortfolio(tenant(req), id);
    const p = { portfolio_id: id, name: b.data.name, holdings: parsed.holdings.map((h) => ({ symbol: h.symbol, value_usd: h.value_usd })), created_at: prev?.created_at ?? now().toISOString(), created_by: prev?.created_by ?? (req as Req).user ?? "anonymous", updated_at: now().toISOString() };
    store.putPortfolio(tenant(req), p);
    audit(req, { event: prev ? "portfolio_updated" : "portfolio_saved", detail: { portfolio_id: id } });
    res.status(prev ? 200 : 201).json(p);
  });
  router.get("/portfolios", (req, res) => res.json({ portfolios: store.listPortfolios(tenant(req)) }));
  router.get("/portfolios/:id", async (req, res) => {
    const p = store.getPortfolio(tenant(req), String(req.params.id));
    if (!p) throw new ApiError(404, "not_found", "Portfolio not found.");
    if (req.query.analyze !== "1") return void res.json(p);
    const parsed = parseHoldings(p.holdings);
    if (!parsed.ok) throw new ApiError(422, "invalid_request", parsed.error);
    const t = now();
    const data = await fetchHoldingBars(parsed.holdings, { now: t, fetchImpl: deps.fetchImpl, cacheDir: deps.cacheDir, offline: deps.offline });
    res.json({ portfolio: p, generated_at: t.toISOString(), analysis: analyzePortfolio(parsed.holdings, { ...data, etfs: await fetchEtfData(parsed.holdings, deps.fetchImpl) }) });
  });
  router.delete("/portfolios/:id", (req, res) => {
    if (!store.deletePortfolio(tenant(req), String(req.params.id))) throw new ApiError(404, "not_found", "Portfolio not found.");
    audit(req, { event: "portfolio_deleted", detail: { portfolio_id: String(req.params.id) } });
    res.json({ deleted: true });
  });

  // ── Webhook alerts (admin) ────────────────────────────────────────────
  const whView = (w: WebhookRecord) => ({ webhook_id: w.webhook_id, url: w.url, events: w.events, active: w.active, created_at: w.created_at, created_by: w.created_by, last_delivery: w.last_delivery ?? null });
  router.post("/webhooks", async (req, res) => {
    const b = z.object({ url: z.string().url().max(500), events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).default([...WEBHOOK_EVENTS]) }).strict().safeParse(req.body);
    if (!b.success) throw new ApiError(422, "invalid_request", "Invalid webhook.", b.error.issues);
    try {
      await assertSafeWebhookUrl(b.data.url, deps.resolveHost);
    } catch (e) {
      throw new ApiError(422, "invalid_request", `Webhook url refused: ${e instanceof Error ? e.message : String(e)}.`);
    }
    if (store.listWebhooks(tenant(req)).length >= 10) throw new ApiError(409, "conflict", "At most 10 webhooks per account.");
    const w: WebhookRecord = { webhook_id: shortId("wh", [tenant(req), b.data.url, now().toISOString()]), url: b.data.url, events: [...new Set(b.data.events)], secret: newWebhookSecret(), created_at: now().toISOString(), created_by: (req as Req).user ?? "anonymous", active: true };
    store.putWebhook(tenant(req), w);
    audit(req, { event: "webhook_created", detail: { webhook_id: w.webhook_id, url_host: new URL(w.url).host } });
    res.status(201).json({ ...whView(w), secret: w.secret, note: "Store this signing secret now; it is not shown again. Verify HMAC-SHA256 over timestamp + '.' + body (header x-sentinel-signature: sha256=...)." });
  });
  router.get("/webhooks", (req, res) => res.json({ webhooks: store.listWebhooks(tenant(req)).map(whView), events: WEBHOOK_EVENTS }));
  router.delete("/webhooks/:id", (req, res) => {
    if (!store.deleteWebhook(tenant(req), String(req.params.id))) throw new ApiError(404, "not_found", "Webhook not found.");
    audit(req, { event: "webhook_deleted", detail: { webhook_id: String(req.params.id) } });
    res.json({ deleted: true });
  });
  router.post("/webhooks/:id/test", async (req, res) => {
    const w = store.getWebhook(tenant(req), String(req.params.id));
    if (!w) throw new ApiError(404, "not_found", "Webhook not found.");
    const n = await dispatchWebhooks({ store, now, webhookPost: deps.webhookPost, resolveHost: deps.resolveHost }, tenant(req), w.events[0]!, { test: true });
    res.json({ delivered: n, last_delivery: store.getWebhook(tenant(req), w.webhook_id)?.last_delivery ?? null });
  });

  // ── Portfolio view (PRD Phase 4): concentration, correlation, stress ───
  router.post("/portfolio", async (req, res) => {
    const b = z.object({ holdings: z.array(z.object({ symbol: z.string().min(1).max(10), value_usd: z.number().finite() }).strict()).min(1).max(20) }).strict().safeParse(req.body);
    if (!b.success) throw new ApiError(422, "invalid_request", "Invalid request.", b.error.issues);
    const parsed = parseHoldings(b.data.holdings);
    if (!parsed.ok) throw new ApiError(422, "invalid_request", parsed.error);
    const t = now();
    const data = await fetchHoldingBars(parsed.holdings, { now: t, fetchImpl: deps.fetchImpl, cacheDir: deps.cacheDir, offline: deps.offline });
    const analysis = analyzePortfolio(parsed.holdings, { ...data, etfs: await fetchEtfData(parsed.holdings, deps.fetchImpl) });
    audit(req, { event: "portfolio_requested", detail: { symbols: parsed.holdings.map((h) => h.symbol), status: analysis.status } }, t);
    res.json({ generated_at: t.toISOString(), methodology_version: METHODOLOGY_VERSION, portfolio: analysis, disclaimer: "Decision support only; not investment advice." });
  });

  // ── Investment assessment (async) ──────────────────────────────────────
  router.post("/investment-assessment", async (req, res) => {
    const b = AssessmentRequest.safeParse(req.body);
    if (!b.success) throw new ApiError(422, "invalid_request", "Invalid request.", b.error.issues);
    const ver = loadDossier(req, b.data.asset_id);
    const h = startAnalysis(deps, tenant(req), ver, { requestedBy: (req as Req).user ?? "api", scenarioConfig: b.data.scenario_config, overrides: b.data.overrides, force: b.data.force });
    if (b.data.wait) {
      const done = await h.done;
      res.status(done.status === "failed" ? 500 : 200).json(done.status === "failed" ? { ...summary(done), error: { code: "analysis_failed", message: done.error } } : { ...summary(done), report: done.report });
      return;
    }
    res.status(h.deduped ? 200 : 202).json({ ...summary(h.record), deduplicated: h.deduped, poll: `/api/v1/analyses/${h.record.analysis_id}` });
  });

  router.get("/analyses/:id", (req, res) => {
    const rec = store.getAnalysis(tenant(req), String(req.params.id));
    if (!rec) throw new ApiError(404, "not_found", "Analysis not found.");
    if (req.query.summary !== "1") gate(req, rec);
    res.json(req.query.summary === "1" || rec.status !== "completed" ? summary(rec) : { ...summary(rec), result: rec.report });
  });

  router.get("/analyses/:id/report", (req, res) => {
    const rec = store.getAnalysis(tenant(req), String(req.params.id));
    if (!rec) throw new ApiError(404, "not_found", "Analysis not found.");
    gate(req, rec);
    const report = reportOf(rec);
    const fmt = String(req.query.format ?? (req.accepts(["json", "html"]) === "html" ? "html" : "json"));
    if (fmt === "html") {
      res.type("html").send(req.query.fragment === "1" ? `<style>${REPORT_CSS}</style>${renderReportBody(report)}` : renderReportHtml(report));
      return;
    }
    if (fmt === "csv") {
      res.type("text/csv").setHeader("content-disposition", `attachment; filename="sentinel-${rec.analysis_id}.csv"`);
      res.send(reportCsv(report));
      return;
    }
    res.json(report);
  });

  // Full tenant export (admin): assets with every version, analyses, audit trail.
  router.get("/export", (req, res) => {
    const t = tenant(req);
    audit(req, { event: "tenant_exported" });
    res.setHeader("content-disposition", `attachment; filename="sentinel-export-${t}.json"`);
    res.json({
      exported_at: now().toISOString(), tenant: t, methodology_version: METHODOLOGY_VERSION,
      assets: store.listAssets(t).map((a) => store.getAsset(t, a.asset_id)),
      analyses: store.listAnalyses(t), monitors: store.listMonitors(t), audit: store.readAudit(t),
    });
  });

  // ── Analyst assignment ────────────────────────────────────────────────
  router.get("/analyses", (req, res) => {
    const me = (req as Req).user;
    const want = req.query.assigned_to === "me" ? me : req.query.assigned_to ? String(req.query.assigned_to) : null;
    let list = store.listAnalyses(tenant(req)).filter((a) => a.status === "completed");
    if (want) list = list.filter((a) => a.assignee?.user === want);
    if (req.query.review === "pending") list = list.filter((a) => !a.review);
    if (req.query.review === "unassigned") list = list.filter((a) => !a.assignee);
    if (deps.requireApproval && (req as Req).role === "viewer") list = list.filter((a) => a.review?.status === "approved");
    res.json({ analyses: list.map((a) => ({ ...summary(a), assignee: a.assignee ?? null })) });
  });

  router.post("/analyses/:id/assign", (req, res) => {
    const b = z.object({ assignee: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/u) }).strict().safeParse(req.body);
    if (!b.success) throw new ApiError(422, "invalid_request", "assignee must be a user name ([A-Za-z0-9_-], max 40).", b.error.issues);
    const rec = store.getAnalysis(tenant(req), String(req.params.id));
    if (!rec) throw new ApiError(404, "not_found", "Analysis not found.");
    reportOf(rec);
    if (rec.review) throw new ApiError(409, "conflict", "This report was already reviewed.");
    const known = [...keys.values()].filter((p) => p.tenant === tenant(req));
    if (known.length && !known.some((p) => p.user === b.data.assignee && p.role !== "viewer")) throw new ApiError(422, "invalid_request", `"${b.data.assignee}" is not an analyst or admin in this account.`);
    const next = store.updateAnalysis(tenant(req), rec.analysis_id, { assignee: { user: b.data.assignee, assigned_by: (req as Req).user ?? "anonymous", at: now().toISOString() } });
    audit(req, { event: "analysis_assigned", analysis_id: rec.analysis_id, asset_id: rec.asset_id, detail: { assignee: b.data.assignee } });
    res.json({ ...summary(next), assignee: next.assignee });
  });

  router.post("/analyses/:id/review", (req, res) => {
    const b = z.object({ decision: z.enum(["approved", "changes_requested"]), reviewer: z.string().min(1).max(120).optional(), notes: z.string().max(2000).default("") }).strict().safeParse(req.body);
    if (!b.success) throw new ApiError(422, "invalid_request", "Invalid review.", b.error.issues);
    const rec = store.getAnalysis(tenant(req), String(req.params.id));
    if (!rec) throw new ApiError(404, "not_found", "Analysis not found.");
    reportOf(rec);
    if (rec.assignee && (req as Req).role !== "admin" && (req as Req).user !== rec.assignee.user && (req as Req).user !== "anonymous")
      throw new ApiError(403, "forbidden", `This report is assigned to ${rec.assignee.user}; only the assignee or an admin can review it.`);
    const reviewer = (req as Req).user && (req as Req).user !== "anonymous" ? (req as Req).user! : (b.data.reviewer ?? "analyst");
    const review = { status: b.data.decision, reviewer, notes: b.data.notes, at: now().toISOString() };
    const next = store.updateAnalysis(tenant(req), rec.analysis_id, { review });
    audit(req, { event: "analyst_review", analysis_id: rec.analysis_id, asset_id: rec.asset_id, detail: { decision: review.status, reviewer } }, now());
    res.json({ ...summary(next), note: "The review is recorded beside the report; it does not change the automated status or the report hashes." });
  });

  router.get("/analyses/:id/audit", (req, res) => {
    const rec = store.getAnalysis(tenant(req), String(req.params.id));
    if (!rec) throw new ApiError(404, "not_found", "Analysis not found.");
    res.json({ analysis_id: rec.analysis_id, events: store.readAudit(tenant(req), { analysis_id: rec.analysis_id }) });
  });

  router.get("/analyses/:id/reproduce", async (req, res) => {
    const rec = store.getAnalysis(tenant(req), String(req.params.id));
    if (!rec) throw new ApiError(404, "not_found", "Analysis not found.");
    const r = reportOf(rec);
    const asset = store.getAsset(tenant(req), rec.asset_id);
    const ver = asset?.versions.find((v) => v.dossier_version === rec.dossier_version);
    if (!ver) throw new ApiError(404, "not_found", "The dossier version used by this analysis is no longer retained.");
    const again = await runAssessment(ver.dossier, { now: new Date(r.generated_at), snapshot: r.market.snapshot, peerRows: r.peers?.rows, lookthrough: r.etf_lookthrough ?? null, thresholds: r.inputs.thresholds, scenarioConfig: r.inputs.scenario_config, reportVersion: r.report_version, previousAnalysisId: r.inputs.previous_analysis_id ?? undefined, analysisId: r.report_id });
    res.json({ analysis_id: rec.analysis_id, reproduced: again.hashes.calculation_hash === r.hashes.calculation_hash, original_calculation_hash: r.hashes.calculation_hash, recomputed_calculation_hash: again.hashes.calculation_hash, inputs: { dossier_version: r.inputs.dossier_version, market_snapshot_id: r.inputs.market_snapshot_id, methodology_version: r.methodology_version }, note: "Recomputed from the retained dossier version and market snapshot. The narrative is excluded because model text is not deterministic." });
  });

  router.get("/analyses/:a/compare/:b", (req, res) => {
    const a = store.getAnalysis(tenant(req), String(req.params.a));
    const b = store.getAnalysis(tenant(req), String(req.params.b));
    if (!a || !b) throw new ApiError(404, "not_found", "Analysis not found.");
    res.json(compareReports(reportOf(a), reportOf(b)));
  });

  // ── Monitoring (FR-16) ─────────────────────────────────────────────────
  router.post("/monitors", (req, res) => {
    const b = z.object({ analysis_id: z.string(), thresholds: z.array(z.object({ threshold_id: z.string(), trigger: z.number() }).strict()).optional() }).strict().safeParse(req.body);
    if (!b.success) throw new ApiError(422, "invalid_request", "Invalid request.", b.error.issues);
    const rec = store.getAnalysis(tenant(req), b.data.analysis_id);
    if (!rec) throw new ApiError(404, "not_found", "Analysis not found.");
    const r = reportOf(rec);
    const overrides = new Map((b.data.thresholds ?? []).map((t) => [t.threshold_id, t.trigger]));
    const thresholds = r.monitoring.thresholds.map((t) => (overrides.has(t.threshold_id) ? { ...t, trigger: overrides.get(t.threshold_id) as number } : t));
    const mon: MonitorRecord = {
      monitor_id: shortId("mon", { a: rec.analysis_id, t: thresholds }), analysis_id: rec.analysis_id, asset_id: rec.asset_id,
      created_at: now().toISOString(), thresholds, baseline: baselineFromReport(r), baseline_dossier_version: rec.dossier_version,
      last_checked_at: null, alerts: [],
    };
    store.putMonitor(tenant(req), mon);
    audit(req, { event: "monitor_created", analysis_id: rec.analysis_id, asset_id: rec.asset_id, detail: { monitor_id: mon.monitor_id } }, now());
    res.status(201).json(mon);
  });

  router.get("/monitors/:id", (req, res) => {
    const m = store.getMonitor(tenant(req), String(req.params.id));
    if (!m) throw new ApiError(404, "not_found", "Monitor not found.");
    res.json(m);
  });
  router.get("/monitors", (req, res) => res.json({ monitors: store.listMonitors(tenant(req)) }));

  router.post("/monitors/:id/check", async (req, res) => {
    const b = z.object({ simulate: z.record(z.string(), z.number()).optional(), reassess: z.boolean().optional() }).strict().safeParse(req.body ?? {});
    if (!b.success) throw new ApiError(422, "invalid_request", "Invalid request.", b.error.issues);
    const mon = store.getMonitor(tenant(req), String(req.params.id));
    if (!mon) throw new ApiError(404, "not_found", "Monitor not found.");
    res.json(await performMonitorCheck(deps, tenant(req), mon, { simulate: b.data.simulate, reassess: b.data.reassess, requestedBy: "monitor" }));
  });

  // ── Agent service view ────────────────────────────────────────────────
  router.get("/agent/metrics", (req, res) => res.json(usageMetrics(store.listAnalyses(tenant(req)), store.readAudit(tenant(req)), store.readLedger(), now())));
  router.get("/agent/economics", (_req, res) => res.json(economics(store.readLedger(), deps.serviceInfo().price_usd)));

  router.get("/agent", (req, res) => {
    const tasks = store.listAnalyses(tenant(req)).filter((a) => a.task).map((a) => ({ analysis_id: a.analysis_id, asset_id: a.asset_id, status: a.status, assessment_status: a.assessment_status, report_hash: a.report_hash, task: a.task }));
    res.json({ service: serviceCatalog(deps.serviceInfo()), tasks, economics: economics(store.readLedger(), deps.serviceInfo().price_usd) });
  });

  router.get("/agent/jobs", async (req, res) => {
    const info = deps.serviceInfo();
    const network = String(req.query.network ?? info.network);
    if (!CHAIN_IDS.includes(network)) throw new ApiError(422, "invalid_request", "Unknown network.");
    if (!info.agent_address) throw new ApiError(404, "not_found", "This agent has no wallet address.");
    try {
      const jobs = await listProviderJobs(deps.fetchImpl ?? defaultFetch, network, info.agent_address, { limit: Math.min(25, Math.max(1, Number(req.query.limit) || 10)) });
      res.json({ provider: info.agent_address, network, jobs, note: "Jobs funded for this agent in roughly the last day, read from JobFunded events. Older jobs: look one up by id." });
    } catch (e) {
      throw new ApiError(502, "internal", `Could not list jobs from the chain: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  router.get("/agent/jobs/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 0) throw new ApiError(422, "invalid_request", "Job id must be a non-negative integer.");
    const network = String(req.query.network ?? deps.serviceInfo().network);
    if (!CHAIN_IDS.includes(network)) throw new ApiError(422, "invalid_request", "Unknown network.");
    try {
      const job = await readJob(deps.fetchImpl ?? defaultFetch, network, id);
      if (!job) throw new ApiError(404, "not_found", `No ERC-8183 job ${id} on ${network}.`);
      const me = deps.serviceInfo().agent_address;
      const f = deps.fetchImpl ?? defaultFetch;
      let deliverable_url: string | null = null;
      let result: Awaited<ReturnType<typeof summarizeDeliverable>> | null = null;
      let result_error: string | null = null;
      if (job.submitted_at) {
        deliverable_url = (await deliverableUrls(f, network, [id]).catch(() => new Map<number, string>())).get(id) ?? null;
        if (deliverable_url) result = await summarizeDeliverable(f, deliverable_url).catch((e: unknown) => ((result_error = e instanceof Error ? e.message : String(e)), null));
      }
      res.json({ job, deliverable_url, result, result_error, is_this_agent: !!me && job.provider.toLowerCase() === me.toLowerCase(), note: "Read directly from the chain; no wallet or signing is used. COMPLETED means the escrow was released to the provider." });
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(502, "internal", `Could not read the chain: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  router.get("/agent/hire", (_req, res) => res.json(deps.hirer ? deps.hirer.info() : { enabled: false, note: "Hiring from this page is a local demo helper. Set SENTINEL_HIRE_BUYER_DIR to a funded buyer project to enable it." }));
  router.post("/agent/hire", (req, res) => {
    if (!deps.hirer) throw new ApiError(404, "not_found", "Hiring from the UI is not enabled on this server.");
    if (!isLoopback(req.socket.remoteAddress) || req.headers["x-forwarded-for"]) throw new ApiError(403, "forbidden", "Hiring from the UI is only available to a caller on the same machine.");
    const b = z.object({ task: z.string().min(1).max(40) }).strict().safeParse(req.body);
    if (!b.success) throw new ApiError(422, "invalid_request", 'Body must be {"task":"equity:NVDA"}.');
    try {
      res.status(202).json(deps.hirer.start(b.data.task.trim()));
    } catch (e) {
      const code = (e as { code?: number }).code;
      if (code === 409 || code === 422 || code === 429) throw new ApiError(code === 409 ? 409 : code === 429 ? 429 : 422, code === 409 ? "conflict" : code === 429 ? "rate_limited" : "invalid_request", (e as Error).message);
      throw e;
    }
  });
  router.get("/agent/hire/:id", (req, res) => {
    const run = deps.hirer?.get(String(req.params.id));
    if (!run) throw new ApiError(404, "not_found", "No such hire.");
    res.json(run);
  });
  router.get("/demo/real-docs-case", async (req, res) => {
    const sym = String(req.query.symbol ?? "NVDA").toUpperCase();
    const issuer = String(req.query.issuer ?? "xstocks").toLowerCase();
    if (issuer !== "ondo" && issuer !== "xstocks") throw new ApiError(422, "invalid_request", 'issuer must be "ondo" or "xstocks".');
    try {
      const c = await realDocsCase(sym, issuer, deps.fetchImpl);
      if (!c) throw new ApiError(404, "not_found", "No registered BSC token for that symbol and issuer.");
      res.json(c);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(502, "internal", `Could not fetch the issuer document: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  router.get("/demo/evidence-case", (req, res) => {
    const c = evidenceCaseDossier(String(req.query.symbol ?? "NVDA").toUpperCase());
    if (!c) throw new ApiError(404, "not_found", "No registered token for that symbol on BSC.");
    res.json({ dossier: c, note: "Real on-chain token + a labelled test-fixture document with a planted supply error, an unverified custody claim and an injected instruction. POST the dossier to /assets, then /investment-assessment." });
  });
  router.get("/demo/dossier", (req, res) => res.json(demoDossier(String(req.query.symbol ?? "AAPL").toUpperCase())));
  router.get("/config/thresholds", (_req, res) => res.json({ thresholds: deps.thresholds ?? loadThresholds() }));

  // 404 + error mapper
  router.use((_req, _res, next) => next(new ApiError(404, "not_found", "No such endpoint.")));
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, issues: err.issues } });
    } else if (err instanceof StoreError) {
      res.status(err.code === "invalid_id" ? 422 : 404).json({ error: { code: err.code === "invalid_id" ? "invalid_request" : "not_found", message: err.message } });
    } else if (err && typeof err === "object" && "type" in err && (err as { type: string }).type === "entity.parse.failed") {
      res.status(400).json({ error: { code: "invalid_request", message: "Request body is not valid JSON." } });
    } else if (err && typeof err === "object" && "type" in err && (err as { type: string }).type === "entity.too.large") {
      res.status(413).json({ error: { code: "too_large", message: "Request body too large." } });
    } else {
      console.error("[sentinel] unhandled", err instanceof Error ? err.message : err);
      res.status(500).json({ error: { code: "internal", message: "Unexpected server error." } });
    }
  });
  return router;
}


/** One monitoring pass (used by the API and the optional scheduler). */
export async function performMonitorCheck(
  deps: RunnerEnv,
  tenantId: string,
  mon: MonitorRecord,
  o: { simulate?: Record<string, number>; reassess?: boolean; requestedBy: string },
) {
  const { store } = deps;
  const rec = store.getAnalysis(tenantId, mon.analysis_id);
  const ver = store.latestDossier(tenantId, mon.asset_id);
  if (!rec || !ver) throw new ApiError(404, "not_found", "The monitored analysis or asset no longer exists.");
  const t = deps.now();
  const snapshot = await buildMarketSnapshot(ver.dossier, { now: t, fetchImpl: deps.fetchImpl, offline: deps.offline, cacheDir: deps.cacheDir, overrides: o.simulate, allowSimulation: process.env.SENTINEL_ALLOW_SIMULATION === "1" });
  const alerts: MonitorAlert[] = evaluateThresholds({ thresholds: mon.thresholds as never, baseline: mon.baseline, baselineDossierVersion: mon.baseline_dossier_version, tokensPerShare: ver.dossier.token?.tokens_per_share ?? null, currentDossierVersion: ver.dossier_version, snapshot });
  const triggered = alerts.filter((a) => a.triggered);
  const reasons = triggered.map((a) => `${a.label}: ${a.note}${a.simulated ? " [SIMULATED test change]" : ""}`);
  store.putMonitor(tenantId, { ...mon, last_checked_at: t.toISOString(), alerts });
  let outdatedRec = rec;
  if (triggered.length) {
    outdatedRec = store.updateAnalysis(tenantId, rec.analysis_id, { outdated: { since: rec.outdated?.since ?? t.toISOString(), reasons } });
    store.audit(tenantId, { event: "analysis_marked_outdated", analysis_id: rec.analysis_id, asset_id: rec.asset_id, detail: { reasons, simulated: triggered.some((a) => a.simulated), by: o.requestedBy } }, t);
  }
  if (triggered.length) void dispatchWebhooks({ store, now: deps.now, webhookPost: deps.webhookPost, resolveHost: deps.resolveHost }, tenantId, "monitor.triggered", { monitor_id: mon.monitor_id, analysis_id: rec.analysis_id, asset_id: rec.asset_id, triggered: triggered.map((a) => ({ threshold_id: a.threshold_id, label: a.label, baseline: a.baseline, current: a.current })) }).catch(() => undefined);
  let reassessment: unknown = null;
  if (triggered.length && o.reassess) {
    const h = startAnalysis(deps, tenantId, ver, { requestedBy: o.requestedBy, previous: outdatedRec, overrides: o.simulate, force: true, scenarioConfig: outdatedRec.report?.inputs.scenario_config ?? undefined });
    const done = await h.done;
    reassessment = { ...summary(done), compare: done.status === "completed" && outdatedRec.report ? compareReports(outdatedRec.report, done.report as SentinelReport) : null };
  }
  return {
    monitor_id: mon.monitor_id, checked_at: t.toISOString(), market_data_quality: snapshot.data_quality_status,
    simulated: Object.keys(o.simulate ?? {}).length > 0, evaluated: alerts, triggered,
    analysis: { analysis_id: rec.analysis_id, potentially_outdated: triggered.length > 0, reasons },
    recommendation: triggered.length ? "Reassess: material change detected against configured thresholds." : "No configured threshold crossed.",
    reassessment, note: "Monitoring covers retrievable public data and dossier updates only; it cannot observe private asset performance without a data integration.",
  };
}

/** Optional background monitoring across all tenants (SENTINEL_MONITOR_INTERVAL_MINUTES). */
export function startMonitorScheduler(deps: RunnerEnv, intervalMinutes: number, autoReassess: boolean): () => void {
  const tick = async () => {
    for (const tenantId of deps.store.allTenants()) {
      for (const mon of deps.store.listMonitors(tenantId)) {
        try {
          const a = deps.store.getAnalysis(tenantId, mon.analysis_id);
          if (!a || a.outdated) continue; // already flagged; wait for a reassessment
          await performMonitorCheck(deps, tenantId, mon, { reassess: autoReassess, requestedBy: "scheduler" });
        } catch (e) {
          console.error("[sentinel] scheduled monitor check failed", mon.monitor_id, e instanceof Error ? e.message : e);
        }
      }
    }
  };
  const h = setInterval(() => void tick(), Math.max(1, intervalMinutes) * 60_000);
  h.unref();
  return () => clearInterval(h);
}

/** Revenue vs model cost (the self-funding view). Never invents a cost for unpriced models. */
export function economics(entries: LedgerEntry[], priceUsd: string) {
  const reports = entries.filter((e) => e.kind === "report_submitted");
  const calls = entries.filter((e) => e.kind === "llm_call");
  const tokens = calls.reduce((s, e) => s + (e.input_tokens ?? 0) + (e.output_tokens ?? 0), 0);
  const priced = calls.every((e) => e.cost_usd !== null && e.cost_usd !== undefined);
  const cost = priced ? round(calls.reduce((s, e) => s + (e.cost_usd ?? 0), 0), 6) : null;
  const price = Number(priceUsd);
  const quoted = reports.length * (Number.isFinite(price) ? price : 0);
  return {
    reports_submitted: reports.length,
    price_per_report_usd: priceUsd,
    quoted_value_usd: round(quoted, 6),
    revenue_note: "Quoted value only: revenue is earned when the buyer settles on-chain after the dispute window; settlement is not tracked here.",
    llm_calls: calls.length,
    llm_tokens: tokens,
    llm_cost_usd: cost,
    llm_cost_note: cost === null ? "Model pricing is unknown for at least one call; tokens are shown instead of an invented cost." : "All recorded calls used a zero-priced model.",
    margin_per_report_usd: cost !== null && reports.length > 0 ? round((quoted - cost) / reports.length, 6) : null,
  };
}

export function summary(r: AnalysisRecord) {
  return {
    analysis_id: r.analysis_id, asset_id: r.asset_id, status: r.status, stage: r.stage,
    assessment_status: r.assessment_status, report_version: r.report_version, dossier_version: r.dossier_version,
    previous_analysis_id: r.previous_analysis_id, created_at: r.created_at, completed_at: r.completed_at,
    outdated: r.outdated, review: r.review ?? null, calculation_hash: r.calculation_hash, report_hash: r.report_hash,
    task: r.task as TaskRef | null, error: r.error,
  };
}

export { deriveMonitoringThresholds };
