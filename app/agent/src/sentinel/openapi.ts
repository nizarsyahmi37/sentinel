/** OpenAPI 3.1 description of /api/v1. A test fails if a route exists that is not listed here. */
import { requiredRole } from "./auth.js";
import { CHAIN_IDS } from "./chains.js";
import { SYMBOLS } from "./types.js";

type Op = [method: "get" | "post" | "delete", path: string, summary: string, body?: string];

export const OPERATIONS: Op[] = [
  ["get", "/health", "Service health (public)"],
  ["get", "/services", "Service catalogue, price and input schema (public)"],
  ["get", "/auth/config", "Sign-in options: API keys, OIDC issuer/audience (public)"],
  ["get", "/me", "Who the credential resolves to (tenant, user, role)"],
  ["get", "/assets", "List saved assets"],
  ["post", "/assets", "Create or update an asset dossier", "Dossier"],
  ["get", "/assets/{assetId}", "Asset with versions and analyses (?full=1 includes document text)"],
  ["delete", "/assets/{assetId}", "Delete an asset, its analyses and monitors (admin)"],
  ["post", "/assets/{assetId}/documents", "Upload evidence (PDF, text, or PNG/JPEG scans read by OCR)", "{doc_id, kind, filename, content_base64|text}"],
  ["post", "/assets/{assetId}/documents/{docId}/corrections", "Attributed manual correction of an extracted value", "{field, value, corrected_by, reason}"],
  ["post", "/market-intelligence", "Market intelligence incl. peers", "{asset_id|underlying}"],
  ["post", "/peers", "Peer benchmarking and valuation context", "{asset_id|underlying}"],
  ["post", "/token-verification", "On-chain token verification vs claims", "{asset_id}"],
  ["post", "/underwriting", "Alias of /token-verification (PRD name)", "{asset_id}"],
  ["post", "/investment-assessment", "Integrated assessment (async, or wait:true)", "{asset_id, wait?, force?}"],
  ["get", "/analyses", "List completed analyses (?assigned_to=me&review=pending|unassigned)"],
  ["get", "/analyses/{id}", "Analysis status / result"],
  ["get", "/analyses/{id}/report", "Report as JSON, HTML or CSV (?format=)"],
  ["get", "/analyses/{id}/audit", "Audit trail of one analysis"],
  ["get", "/analyses/{id}/reproduce", "Recompute from stored inputs and compare hashes"],
  ["post", "/analyses/{id}/assign", "Assign to an analyst", "{assignee}"],
  ["post", "/analyses/{id}/review", "Approve or request changes", "{decision, notes?}"],
  ["get", "/analyses/{a}/compare/{b}", "Compare two analyses"],
  ["post", "/monitors", "Create a monitor from a report", "{analysis_id}"],
  ["get", "/monitors", "List monitors"],
  ["get", "/monitors/{id}", "One monitor"],
  ["post", "/monitors/{id}/check", "Check thresholds now (optionally reassess)", "{reassess?}"],
  ["post", "/portfolio", "Analyse holdings (concentration, correlation, look-through, stress)", "{holdings:[{symbol,value_usd}]}"],
  ["get", "/portfolios", "Saved portfolios"],
  ["post", "/portfolios", "Save or update a portfolio", "{name, holdings}"],
  ["get", "/portfolios/{id}", "A saved portfolio (?analyze=1 to analyse it now)"],
  ["delete", "/portfolios/{id}", "Delete a saved portfolio"],
  ["get", "/etf-holdings/{symbol}", "Issuer-published ETF holdings"],
  ["get", "/token-registry", "Known token contracts (third-party listing, on-chain checked)"],
  ["get", "/webhooks", "List webhooks (admin)"],
  ["post", "/webhooks", "Create a signed webhook (admin; https only)", "{url, events?}"],
  ["delete", "/webhooks/{id}", "Delete a webhook (admin)"],
  ["post", "/webhooks/{id}/test", "Send a test event (admin)"],
  ["get", "/agent", "Agent identity, catalogue and delivered tasks"],
  ["get", "/agent/economics", "Revenue vs model cost"],
  ["get", "/agent/metrics", "Usage KPIs and north star"],
  ["get", "/billing/usage", "Monthly usage statement (admin)"],
  ["get", "/export", "Full tenant export (admin)"],
  ["get", "/config/thresholds", "Active screening thresholds"],
  ["get", "/demo/dossier", "Example dossier for a symbol"],
  ["get", "/agent/jobs", "Recent ERC-8183 jobs funded for this agent, newest first (read from chain events)"],
  ["get", "/agent/jobs/{id}", "On-chain ERC-8183 job read directly from the chain (?network=); shows status, parties, budget and deliverable hash"],
  ["get", "/agent/hire", "Whether the local demo buyer is enabled, with its limits"],
  ["post", "/agent/hire", "Local demo only: hire this agent as a buyer ({task:\"equity:NVDA\"}); loopback callers, admin role, capped"],
  ["get", "/agent/hire/{id}", "Progress of a demo hire (steps and job id)"],
  ["get", "/demo/real-docs-case", "Real token + the issuer's own public documents (?symbol=&issuer=ondo|xstocks), fetched from the issuer's site"],
  ["get", "/demo/evidence-case", "Demo dossier: real token + planted document errors (conflict, unverified claim, injection)"],
  ["get", "/openapi.json", "This document (public)"],
];

export function buildOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [m, p, summary, body] of OPERATIONS) {
    const exp = p.replace(/\{[^}]+\}/gu, ":x");
    const publicOp = ["/health", "/services", "/auth/config", "/openapi.json"].includes(p);
    (paths[p] ??= {})[m] = {
      summary, ...(publicOp ? { security: [] } : {}), "x-required-role": publicOp ? "none" : requiredRole(m.toUpperCase(), exp),
      ...(body ? { requestBody: { required: true, content: { "application/json": { schema: { type: "object", description: body } } } } } : {}),
      parameters: [...p.matchAll(/\{([^}]+)\}/gu)].map((x) => ({ name: x[1], in: "path", required: true, schema: { type: "string" } })),
      responses: { "200": { description: "OK" }, "401": { description: "Missing or invalid credential" }, "403": { description: "Role does not allow this operation" }, "422": { description: "Invalid request" } },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Sentinel API", version: "1.0.0", description: "Tokenized stock/ETF verification and market intelligence. Decision support only; not investment advice." },
    servers: [{ url: "/api/v1" }],
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "API key or OIDC JWT" } }, "x-supported": { underlyings: SYMBOLS, chains: CHAIN_IDS } },
    security: [{ bearer: [] }],
    paths,
  };
}
