/**
 * Usage metering and monthly statements (PRD Phase 2 "usage-based billing").
 * This meters and prices usage; it does not collect money. Paid agent jobs
 * (ERC-8183 / x402) are settled on-chain at job time and are listed but not
 * billed again here.
 */
import type { AnalysisRecord, AuditEvent } from "./store.js";

export interface PriceBook {
  currency: "USD";
  report: number;
  market_intelligence: number;
  token_verification: number;
  peers: number;
  portfolio: number;
}

export function loadPriceBook(reportPriceUsd: string, env: NodeJS.ProcessEnv = process.env): PriceBook {
  const base: PriceBook = { currency: "USD", report: Number(reportPriceUsd) || 0, market_intelligence: 0, token_verification: 0, peers: 0, portfolio: 0 };
  if (!env.SENTINEL_BILLING_JSON) return base;
  try {
    const j = JSON.parse(env.SENTINEL_BILLING_JSON) as Partial<PriceBook>;
    for (const k of ["report", "market_intelligence", "token_verification", "peers", "portfolio"] as const) if (typeof j[k] === "number" && j[k]! >= 0) base[k] = j[k]!;
  } catch {
    /* ignore malformed override; defaults stay */
  }
  return base;
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function billingStatement(tenant: string, month: string, analyses: AnalysisRecord[], audit: AuditEvent[], prices: PriceBook) {
  const inMonth = (iso: string | null | undefined) => (iso ?? "").startsWith(month);
  const done = analyses.filter((a) => a.status === "completed" && inMonth(a.completed_at));
  const billable = done.filter((a) => !a.task);
  const agentSettled = done.filter((a) => a.task);
  const count = (ev: string) => audit.filter((e) => e.event === ev && inMonth(e.at));
  const lines = [
    { item: "Integrated assessment reports", unit_price: prices.report, quantity: billable.length },
    { item: "Market intelligence requests", unit_price: prices.market_intelligence, quantity: count("market_intelligence_requested").length },
    { item: "Token verification requests", unit_price: prices.token_verification, quantity: count("token_verification_requested").length },
    { item: "Peer benchmarking requests", unit_price: prices.peers, quantity: count("peers_requested").length },
    { item: "Portfolio analyses", unit_price: prices.portfolio, quantity: count("portfolio_requested").length },
  ].map((l) => ({ ...l, amount: r6(l.unit_price * l.quantity) }));
  const byUser: Record<string, { reports: number; requests: number }> = {};
  const u = (name: string) => (byUser[name] ??= { reports: 0, requests: 0 });
  for (const a of billable) u(a.requested_by).reports++;
  for (const e of audit) if (inMonth(e.at) && e.actor && /_requested$/u.test(e.event) && e.event !== "analysis_requested") u(e.actor).requests++;
  return {
    tenant, month, currency: prices.currency, price_book: prices, lines, total: r6(lines.reduce((s, l) => s + l.amount, 0)),
    by_user: byUser,
    agent_settled_jobs: { count: agentSettled.length, note: "Paid through the on-chain job (ERC-8183 / x402) at request time; not billed again here." },
    notes: ["Metering statement only: Sentinel does not collect payment for API usage. Export this to your invoicing system.", "Prices are set by the operator (SENTINEL_BILLING_JSON); unset request types are free."],
  };
}
