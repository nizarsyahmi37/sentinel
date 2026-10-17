import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { ingestDocument } from "../src/sentinel/documents.js";
import { derivedValues, evaluateThresholds } from "../src/sentinel/monitor.js";
import { deriveMonitoringThresholds, runAssessment } from "../src/sentinel/pipeline.js";
import { buildMarketSnapshot } from "../src/sentinel/market.js";
import { analyzePeers } from "../src/sentinel/peers.js";
import { buildRisks } from "../src/sentinel/risk.js";
import { fakeMarket, makeFetch, newNet, TOKEN_ADDR, FEED_ADDR } from "./helpers.js";
import { DossierSchema } from "../src/sentinel/types.js";

const now = new Date("2026-10-17T03:00:00Z");
const mk = (sym: string, ret: number) => ({ symbol: sym, kind: "stock" as const, status: "ok" as const, error: null, values: { ret_12m: ret } });

describe("PRD ↔ code gaps closed", () => {
  it("relative strength vs SPY and QQQ is the 12m return gap; null for the benchmark itself", () => {
    const rows = [mk("SPY", 0.1), { ...mk("QQQ", 0.15), kind: "etf" as const }];
    const a = analyzePeers("NVDA", mk("NVDA", 0.3), rows, null);
    assert.ok(Math.abs(a.relative_strength.vs_spy! - 0.2) < 1e-6);
    assert.ok(Math.abs(a.relative_strength.vs_qqq! - 0.15) < 1e-6);
    const q = analyzePeers("QQQ", mk("QQQ", 0.15), rows, null);
    assert.equal(q.relative_strength.vs_qqq, null);
  });

  it("drawdown, premium/discount (oracle divergence) and evidence-age watchers fire on real changes", async () => {
    const net = newNet();
    const last = net.market!.assets.AAPL!.at(-1)!;
    net.token = { address: TOKEN_ADDR, name: "T", symbol: "T", decimals: 18, totalSupply: 10n ** 21n, feed: { address: FEED_ADDR, answer: last, decimals: 8, updatedAt: Math.floor(now.getTime() / 1000) - 3600 } };
    const dossier = DossierSchema.parse({ underlying: "AAPL", token: { chain: "bsc", contract_address: TOKEN_ADDR, price_feed: FEED_ADDR } });
    const r = await runAssessment(dossier, { now, fetchImpl: makeFetch(net), skipPeers: true });
    const ids = r.monitoring.thresholds.map((t) => t.threshold_id);
    for (const id of ["drawdown_widens", "premium_moves", "feed_stale", "fundamentals_stale"]) assert.ok(ids.includes(id), id);
    const base = Object.fromEntries(r.market.snapshot.metrics.map((m) => [m.key, m.value]));
    const dv = derivedValues(r.market.snapshot, 1, new Date(r.market.snapshot.observed_at));
    Object.assign(base, dv);
    const same = evaluateThresholds({ thresholds: r.monitoring.thresholds, baseline: base, baselineDossierVersion: "x", currentDossierVersion: "x", snapshot: r.market.snapshot, tokensPerShare: 1 });
    assert.ok(!same.some((a) => a.triggered), "nothing fires when nothing changed");
    // oracle diverges by +5% and the feed stops updating
    const moved = structuredClone(r.market.snapshot);
    moved.facts.token!.feed!.answer = last * 1.05;
    moved.facts.token!.feed!.updated_at -= 6 * 86_400;
    const fired = evaluateThresholds({ thresholds: r.monitoring.thresholds, baseline: base, baselineDossierVersion: "x", currentDossierVersion: "x", snapshot: moved, tokensPerShare: 1 }).filter((a) => a.triggered).map((a) => a.threshold_id);
    assert.ok(fired.includes("premium_moves") && fired.includes("feed_stale"), fired.join());
    // 20% crash widens the drawdown
    const crashed = structuredClone(r.market.snapshot);
    crashed.facts.bars[crashed.facts.bars.length - 1]!.adj *= 0.8;
    const f2 = evaluateThresholds({ thresholds: r.monitoring.thresholds, baseline: base, baselineDossierVersion: "x", currentDossierVersion: "x", snapshot: crashed, tokensPerShare: 1 }).filter((a) => a.triggered).map((a) => a.threshold_id);
    assert.ok(f2.includes("drawdown_widens"), f2.join());
  });

  it("ETF look-through feeds a holdings-concentration risk; unavailable look-through is stated", async () => {
    const net = newNet({ market: fakeMarket({ SPY: 1 }) });
    const lt = (top10: number) => ({ status: "ok" as const, etf: "SPY", reason: null, as_of: "15-Oct-2026", source_url: "u", count: 504, top10_weight: top10, top: [{ ticker: "NVDA", name: "NVIDIA", weight: 0.08 }] });
    const hi = await runAssessment({ underlying: "SPY" }, { now, fetchImpl: makeFetch(net), skipPeers: true, lookthrough: lt(0.52) });
    const r1 = hi.risks.underlying.find((x) => x.category === "holdings_concentration")!;
    assert.equal(r1.severity, "high");
    assert.match(r1.description, /52%.*NVDA at 8%/u);
    const none = await runAssessment({ underlying: "SPY" }, { now, fetchImpl: makeFetch(net), skipPeers: true, lookthrough: { ...lt(0), status: "unavailable", reason: "HTTP 500", top10_weight: null, top: [] } });
    assert.match(none.risks.underlying.find((x) => x.category === "fund_structure")!.description, /could not be assessed \(HTTP 500\)/u);
  });

  it("documents carry a SHA-256 of the file bytes and the extractor version", async () => {
    const body = "Total tokens outstanding: 5,000\nShares held in custody: 1,000";
    const d = await ingestDocument({ doc_id: "d1", kind: "reserve_report", filename: "r.txt", content_base64: Buffer.from(body).toString("base64") });
    assert.equal(d.document.sha256, createHash("sha256").update(body).digest("hex"));
    assert.equal(d.document.extractor, "plain-text@1");
    assert.equal(d.document.original_filename, "r.txt");
    assert.equal(d.summary.sha256, d.document.sha256);
  });
});

import { evidenceCaseDossier } from "../src/sentinel/demo.js";
import { validateDossier as validate } from "../src/sentinel/pipeline.js";

describe("evidence-engine demo case (REQUIREMENT §5.3)", () => {
  it("is a valid dossier on a registered real token, labelled as a test fixture", () => {
    const d = evidenceCaseDossier("NVDA")!;
    assert.equal(validate(d).ok, true);
    assert.match(d.documents[0]!.title, /TEST FIXTURE/u);
    assert.equal(evidenceCaseDossier("ZZZZ"), null);
  });

  it("the planted conflict and the injected instruction are caught; the injection cannot lift the status", async () => {
    const d = evidenceCaseDossier("NVDA")!;
    const net = newNet({ market: fakeMarket({ NVDA: 1.5, SPY: 1 }) });
    net.token = { address: d.token.contract_address, name: "NVIDIA (T)", symbol: "NVDAon", decimals: 18, totalSupply: 70_000n * 10n ** 18n };
    const r = await runAssessment(d, { now, fetchImpl: makeFetch(net), skipPeers: true });
    assert.ok(r.evidence.conflicts.some((c) => c.field === "token_supply" && (c.max_difference_pct ?? 0) > 90));
    assert.ok(r.evidence.injection_findings.length >= 1);
    assert.notEqual(r.assessment.status, "CONDITIONAL_PASS");
    assert.ok(r.evidence.records.some((e) => e.claim === "custody" && e.verification_status === "UNVERIFIED"));
  });
});
