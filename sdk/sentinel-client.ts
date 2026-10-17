/**
 * Sentinel SDK — a zero-dependency TypeScript client for /api/v1 (Node 18+ / browsers).
 *   const s = new SentinelClient({ baseUrl: "https://host/api/v1", apiKey: "…" });
 *   const { report } = await s.assess("tok-nvda");
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export class SentinelError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly issues?: unknown) {
    super(message);
    this.name = "SentinelError";
  }
}

export interface ClientOptions {
  baseUrl: string;
  /** API key or OIDC bearer token. */
  apiKey?: string;
  fetch?: typeof fetch;
  /** Per-request timeout, default 120 s (assessments fetch live data). */
  timeoutMs?: number;
}

export interface Holding { symbol: string; value_usd: number }
export type Json = Record<string, any>;

export class SentinelClient {
  private f: typeof fetch;
  constructor(private o: ClientOptions) {
    this.f = o.fetch ?? fetch;
  }

  private async req(method: string, path: string, body?: unknown, raw = false): Promise<any> {
    const res = await this.f(this.o.baseUrl.replace(/\/$/u, "") + path, {
      method,
      headers: { "content-type": "application/json", ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 120_000),
    });
    if (!res.ok) {
      let e: any = null;
      try {
        e = (await res.json()).error;
      } catch { /* not json */ }
      throw new SentinelError(res.status, e?.code ?? "http_error", e?.message ?? `HTTP ${res.status}`, e?.issues);
    }
    return raw ? res.text() : res.json();
  }

  health() { return this.req("GET", "/health"); }
  services() { return this.req("GET", "/services"); }
  me() { return this.req("GET", "/me"); }
  openapi() { return this.req("GET", "/openapi.json"); }

  // assets & documents
  saveAsset(dossier: Json) { return this.req("POST", "/assets", dossier); }
  listAssets() { return this.req("GET", "/assets"); }
  getAsset(id: string, full = false) { return this.req("GET", `/assets/${id}${full ? "?full=1" : ""}`); }
  deleteAsset(id: string) { return this.req("DELETE", `/assets/${id}`); }
  uploadDocument(assetId: string, doc: { doc_id: string; kind: string; filename: string; text?: string; content_base64?: string }) { return this.req("POST", `/assets/${assetId}/documents`, doc); }
  correctDocument(assetId: string, docId: string, c: { field: string; value: number; corrected_by: string; reason: string }) { return this.req("POST", `/assets/${assetId}/documents/${docId}/corrections`, c); }

  // analysis
  marketIntelligence(target: { asset_id?: string; underlying?: string }) { return this.req("POST", "/market-intelligence", target); }
  peers(target: { asset_id?: string; underlying?: string }) { return this.req("POST", "/peers", target); }
  tokenVerification(assetId: string) { return this.req("POST", "/token-verification", { asset_id: assetId }); }
  /** Runs an integrated assessment and returns the finished record (with `report`). */
  assess(assetId: string, o: { force?: boolean } = {}) { return this.req("POST", "/investment-assessment", { asset_id: assetId, wait: true, ...o }); }
  /** Starts without waiting; poll with `waitFor`. */
  start(assetId: string) { return this.req("POST", "/investment-assessment", { asset_id: assetId }); }
  async waitFor(analysisId: string, o: { intervalMs?: number; timeoutMs?: number } = {}) {
    const end = Date.now() + (o.timeoutMs ?? 120_000);
    for (;;) {
      const r = await this.req("GET", `/analyses/${analysisId}?summary=1`);
      if (r.status !== "processing") return r.status === "failed" ? Promise.reject(new SentinelError(500, "analysis_failed", r.error ?? "analysis failed")) : this.req("GET", `/analyses/${analysisId}`);
      if (Date.now() > end) throw new SentinelError(504, "timeout", "analysis did not finish in time");
      await new Promise((res) => setTimeout(res, o.intervalMs ?? 1500));
    }
  }
  report(id: string, format: "json" | "html" | "csv" = "json") { return format === "json" ? this.req("GET", `/analyses/${id}/report`) : this.req("GET", `/analyses/${id}/report?format=${format}`, undefined, true); }
  reproduce(id: string) { return this.req("GET", `/analyses/${id}/reproduce`); }
  audit(id: string) { return this.req("GET", `/analyses/${id}/audit`); }
  listAnalyses(q: { assigned_to?: string; review?: "pending" | "unassigned" } = {}) { return this.req("GET", `/analyses${qs(q)}`); }
  assign(id: string, assignee: string) { return this.req("POST", `/analyses/${id}/assign`, { assignee }); }
  review(id: string, decision: "approved" | "changes_requested", notes = "") { return this.req("POST", `/analyses/${id}/review`, { decision, notes }); }

  // monitoring
  createMonitor(analysisId: string) { return this.req("POST", "/monitors", { analysis_id: analysisId }); }
  checkMonitor(id: string, reassess = false) { return this.req("POST", `/monitors/${id}/check`, { reassess }); }

  // portfolios
  analysePortfolio(holdings: Holding[]) { return this.req("POST", "/portfolio", { holdings }); }
  savePortfolio(name: string, holdings: Holding[]) { return this.req("POST", "/portfolios", { name, holdings }); }
  listPortfolios() { return this.req("GET", "/portfolios"); }
  getPortfolio(id: string, analyze = false) { return this.req("GET", `/portfolios/${id}${analyze ? "?analyze=1" : ""}`); }
  deletePortfolio(id: string) { return this.req("DELETE", `/portfolios/${id}`); }

  // reference data
  tokenRegistry(q: { underlying?: string; chain?: string } = {}) { return this.req("GET", `/token-registry${qs(q)}`); }
  etfHoldings(symbol: string) { return this.req("GET", `/etf-holdings/${symbol}`); }

  // admin
  createWebhook(url: string, events?: string[]) { return this.req("POST", "/webhooks", { url, ...(events ? { events } : {}) }); }
  listWebhooks() { return this.req("GET", "/webhooks"); }
  deleteWebhook(id: string) { return this.req("DELETE", `/webhooks/${id}`); }
  testWebhook(id: string) { return this.req("POST", `/webhooks/${id}/test`); }
  metrics() { return this.req("GET", "/agent/metrics"); }
  billing(month?: string) { return this.req("GET", `/billing/usage${qs({ month })}`); }
  exportTenant() { return this.req("GET", "/export"); }
}

const qs = (o: Record<string, string | undefined>) => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined) as [string, string][];
  return p.length ? `?${new URLSearchParams(p).toString()}` : "";
};

/** Verify a Sentinel webhook delivery. Rejects stale timestamps (default 5 minutes) and bad signatures. */
export function verifyWebhook(secret: string, headers: Record<string, string | undefined>, rawBody: string, toleranceSec = 300, nowMs = Date.now()): boolean {
  const ts = headers["x-sentinel-timestamp"];
  const sig = headers["x-sentinel-signature"];
  if (!ts || !sig) return false;
  const age = Math.abs(nowMs - Date.parse(ts)) / 1000;
  if (!Number.isFinite(age) || age > toleranceSec) return false;
  const want = Buffer.from(`sha256=${createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex")}`);
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}
