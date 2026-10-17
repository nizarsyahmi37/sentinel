import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { drawdownSeries, reportCharts, rollingVol } from "../src/sentinel/charts.js";
import { type PeerRow, analyzePeers, gatherPeerRows } from "../src/sentinel/peers.js";
import { runAssessment } from "../src/sentinel/pipeline.js";
import { renderReportHtml } from "../src/sentinel/reportHtml.js";
import { recordSourceFailures } from "../src/sentinel/runner.js";
import { Store } from "../src/sentinel/store.js";
import { usageMetrics } from "../src/sentinel/usage.js";
import { fakeMarket, makeFetch, newNet } from "./helpers.js";

const now = new Date("2026-10-17T03:00:00Z");
const STOCKS = ["AAPL", "GOOGL", "NVDA", "META", "TSLA", "AMZN", "NFLX", "MSFT"] as const;
const row = (symbol: PeerRow["symbol"], pe: number | null, ret = 0.1): PeerRow => ({
  symbol, kind: symbol === "SPY" || symbol === "QQQ" ? "etf" : "stock", status: "ok", error: null,
  values: { ret_12m: ret, volatility_1y: 0.3, max_drawdown_1y: -0.2, beta_spy_1y: 1, pe_ttm: pe, ps_ttm: pe === null ? null : pe / 4, fcf_yield: pe === null ? null : 1 / pe / 2, net_margin: 0.2 },
});
const allMarket = () => fakeMarket(Object.fromEntries([...STOCKS, "QQQ", "SPY"].map((s, i) => [s, 0.8 + i * 0.1])));

describe("peer analysis (FR-07)", () => {
  it("stock subject: compares only with stocks, ranks, and reads the valuation premium", () => {
    const subject = row("NVDA", 40);
    const peers = [...STOCKS.filter((s) => s !== "NVDA").map((s, i) => row(s, 20 + i)), row("QQQ", null), row("SPY", null)];
    const a = analyzePeers("NVDA", subject, peers, null);
    assert.equal(a.comparable, true);
    assert.deepEqual(a.excluded.map((e) => e.symbol).sort(), ["QQQ", "SPY"]);
    assert.ok(a.excluded.every((e) => /not comparable/u.test(e.reason)));
    const pe = a.comparisons.find((c) => c.metric === "pe_ttm")!;
    assert.equal(pe.percentile, 1);
    assert.ok(pe.vs_median! > 0.5);
    assert.equal(a.valuation_context.items.find((i) => i.metric.startsWith("P/E"))!.reading, "premium");
    assert.match(a.valuation_context.summary, /premium/u);
  });

  it("ETF subject with fewer than 3 ETF peers is flagged not sufficiently comparable; multiples n/a", () => {
    const a = analyzePeers("QQQ", row("QQQ", null), [row("SPY", null), ...STOCKS.map((s) => row(s, 25))], null);
    assert.equal(a.comparable, false);
    assert.match(a.comparability_note, /Not sufficiently comparable/u);
    assert.ok(a.comparisons.every((c) => c.peer_median === null));
    assert.equal(a.valuation_context.available, false);
    assert.match(a.valuation_context.summary, /do not apply to ETFs/u);
  });

  it("failed peer data is excluded with a reason and never imputed", () => {
    const failed: PeerRow = { symbol: "AAPL", kind: "stock", status: "failed", error: "HTTP 503", values: {} };
    const a = analyzePeers("NVDA", row("NVDA", 30), [failed, ...STOCKS.filter((s) => !["NVDA", "AAPL"].includes(s)).map((s) => row(s, 25))], null);
    assert.ok(a.excluded.some((e) => e.symbol === "AAPL" && e.reason.startsWith("data unavailable")));
    assert.equal(a.status, "partial");
    assert.ok(!a.peer_set.includes("AAPL"));
  });

  it("gatherPeerRows pulls the other nine symbols from the (fake) sources; outage gives failed rows", async () => {
    const rows = await gatherPeerRows("AAPL", { now, fetchImpl: makeFetch(newNet({ market: allMarket() })) });
    assert.equal(rows.length, 9);
    assert.ok(rows.every((r) => r.status === "ok"));
    assert.ok(rows.find((r) => r.symbol === "NVDA")!.values.pe_ttm !== null);
    assert.equal(rows.find((r) => r.symbol === "QQQ")!.kind, "etf");
    const down = await gatherPeerRows("AAPL", { now, fetchImpl: makeFetch(newNet({ market: allMarket(), fail: { yahoo: true } })) });
    assert.ok(down.every((r) => r.status === "failed"));
  });

  it("report carries peers + valuation sections, charts, and reproduces from stored peer rows", async () => {
    const net = newNet({ market: allMarket() });
    const r = await runAssessment({ underlying: "AAPL" }, { now, fetchImpl: makeFetch(net) });
    assert.equal(r.peers.comparable, true);
    assert.ok(r.stages_completed.includes("peers"));
    const html = renderReportHtml(r);
    assert.match(html, /<h2>6\. Peer \/ comparable market analysis/u);
    assert.match(html, /<h2>7\. Valuation context/u);
    assert.match(html, /Rolling 30-day annualised volatility/u);
    assert.match(html, /Drawdown from running peak/u);
    const again = await runAssessment({ underlying: "AAPL" }, { now, snapshot: r.market.snapshot, peerRows: r.peers.rows });
    assert.equal(again.hashes.calculation_hash, r.hashes.calculation_hash);
    const other = await runAssessment({ underlying: "AAPL" }, { now, snapshot: r.market.snapshot, peerRows: r.peers.rows.map((x) => (x.symbol === "NVDA" ? { ...x, values: { ...x.values, pe_ttm: 999 } } : x)) });
    assert.notEqual(other.hashes.calculation_hash, r.hashes.calculation_hash);
  });

  it("chart helpers", () => {
    const pts = Array.from({ length: 80 }, (_, i) => ({ d: `d${i}`, v: 100 + (i % 7) - (i > 40 ? 10 : 0) }));
    assert.equal(rollingVol(pts, 30).length, 80 - 1 - 30 + 1);
    const dd = drawdownSeries(pts);
    assert.ok(dd.every((p) => p.v <= 0) && Math.min(...dd.map((p) => p.v)) < -0.05);
    assert.match(reportCharts({ underlying: "AAPL", metrics: [] } as never), /not enough price history/u);
  });
});

describe("usage metrics and failure events (PRD §15–16)", () => {
  it("derives only measurable values and reports what is not measured", () => {
    const mk = (id: string, asset: string, status: "completed" | "failed", secs: number, task: any = null) =>
      ({ analysis_id: id, asset_id: asset, status, created_at: "2026-10-01T00:00:00Z", completed_at: new Date(Date.parse("2026-10-01T00:00:00Z") + secs * 1000).toISOString(), assessment_status: status === "completed" ? "NEEDS_REVIEW" : null, task, review: null }) as never;
    const m = usageMetrics(
      [mk("a", "x", "completed", 10), mk("b", "x", "completed", 90), mk("c", "y", "failed", 5), mk("d", "z", "completed", 20, { protocol: "erc8183", status: "SUBMITTED" })],
      [{ event: "data_source_failure", at: "", tenant: "t", detail: { source: "Yahoo" } }, { event: "model_failure", at: "", tenant: "t" }, { event: "manual_correction", at: "", tenant: "t" }],
      [{ at: "", kind: "report_submitted" }],
      new Date("2026-10-17T00:00:00Z"),
    );
    assert.equal(m.usage.assets_analyzed, 2);
    assert.equal(m.usage.reports_delivered, 3);
    assert.equal(m.usage.reports_failed, 1);
    assert.equal(m.usage.repeat_assets, 1);
    assert.equal(m.performance.time_to_report_seconds.median, 20);
    assert.equal(m.performance.within_target_rate, 2 / 3);
    assert.equal(m.commerce.payment_to_delivery_rate, 1);
    assert.equal(m.quality.data_source_failures_by_source.Yahoo, 1);
    assert.equal(m.quality.model_failures, 1);
    assert.equal(m.north_star.value, 3, "all three completed in the current month");
    assert.ok(m.not_measured.length >= 2);
  });

  it("empty store yields nulls, not invented zeros for rates", () => {
    const m = usageMetrics([], [], [], new Date());
    assert.equal(m.usage.completion_rate, null);
    assert.equal(m.performance.time_to_report_seconds.median, null);
    assert.equal(m.commerce.payment_to_delivery_rate, null);
  });

  it("recordSourceFailures writes one audit event per failed source and ignores offline notes", () => {
    const store = new Store(mkdtempSync(path.join(tmpdir(), "sf-")));
    const n = recordSourceFailures(store, "public", now, "a1", "an1", [
      "Yahoo Finance AAPL: live fetch failed (HTTP 503) and no usable cache; unavailable.",
      "BNB Chain RPC unavailable (timeout); token verification could not be performed.",
      "Offline mode: no live sources were queried.",
      "AAPL is an ETF: it files no company financial statements.",
    ]);
    assert.equal(n, 2);
    const ev = store.readAudit("public").filter((e) => e.event === "data_source_failure");
    assert.equal(ev.length, 2);
    assert.equal(ev[0]!.detail!.source, "Yahoo Finance AAPL");
  });
});

import { analyzePortfolio, fetchHoldingBars, parseHoldings } from "../src/sentinel/portfolio.js";

describe("portfolio view (Phase 4)", () => {
  it("parses holdings: merges duplicates, rejects unknown symbols and non-positive values", () => {
    const ok = parseHoldings([{ symbol: "nvda", value_usd: 100 }, { symbol: "NVDA", value_usd: 50 }, { symbol: "QQQ", value_usd: 50 }]);
    assert.ok(ok.ok && ok.holdings.length === 2 && ok.holdings[0]!.value_usd === 150);
    assert.equal(parseHoldings([{ symbol: "BTC", value_usd: 1 }]).ok, false);
    assert.equal(parseHoldings([{ symbol: "AAPL", value_usd: 0 }]).ok, false);
  });

  it("computes weights, concentration, correlation, risk and stress from price history", async () => {
    const p = parseHoldings([{ symbol: "NVDA", value_usd: 6000 }, { symbol: "AAPL", value_usd: 2000 }, { symbol: "QQQ", value_usd: 2000 }]);
    assert.ok(p.ok);
    const data = await fetchHoldingBars(p.holdings, { now, fetchImpl: makeFetch(newNet({ market: allMarket() })) });
    const a = analyzePortfolio(p.holdings, data);
    assert.equal(a.status, "ok");
    assert.equal(a.total_value_usd, 10000);
    assert.equal(a.holdings.find((h) => h.symbol === "NVDA")!.weight, 0.6);
    assert.ok(a.concentration.flags.some((f) => /NVDA is 60%/u.test(f)));
    assert.ok(a.concentration.flags.some((f) => /index ETFs/u.test(f)));
    assert.equal(a.concentration.largest!.symbol, "NVDA");
    assert.ok(a.concentration.effective_positions! > 1 && a.concentration.effective_positions! < 3);
    assert.equal(a.correlation.matrix.length, 3);
    assert.ok(a.correlation.matrix.every((r, i) => r[i] === 1));
    assert.ok(a.risk.volatility_1y! > 0 && a.risk.diversification_ratio! >= 1);
    assert.ok(a.risk.portfolio_beta !== null);
    assert.equal(a.stress.length, 4);
    assert.ok(a.stress[0]!.portfolio_change! < 0);
  });

  it("no price data → unavailable with a reason, never invented risk numbers", async () => {
    const p = parseHoldings([{ symbol: "AAPL", value_usd: 1000 }]);
    assert.ok(p.ok);
    const data = await fetchHoldingBars(p.holdings, { now, fetchImpl: makeFetch(newNet({ fail: { yahoo: true } })) });
    const a = analyzePortfolio(p.holdings, data);
    assert.equal(a.status, "unavailable");
    assert.equal(a.risk.volatility_1y, null);
    assert.ok(a.notes.some((n) => /unavailable/u.test(n)));
  });
});

import { SECTOR_PEERS, gatherSectorPeers } from "../src/sentinel/sectorPeers.js";

describe("sector peers beyond the universe", () => {
  it("resolves tickers via the SEC registry, computes metrics, and reports unresolved tickers", async () => {
    const market = fakeMarket(Object.fromEntries([...STOCKS, "QQQ", "SPY", "AMD", "AVGO", "INTC"].map((s, i) => [s, 0.8 + i * 0.05])));
    const net = newNet({ market });
    const spy = (await import("../src/sentinel/sources.js").then((m) => m.fetchPrices(makeFetch(net), "SPY"))).bars;
    const r = await gatherSectorPeers("NVDA", { fetchImpl: makeFetch(net), spyBars: spy });
    assert.equal(r.sector, "Semiconductors");
    const ok = r.rows.filter((x) => x.status === "ok").map((x) => x.symbol).sort();
    assert.deepEqual(ok, ["AMD", "AVGO", "INTC"]);
    const amd = r.rows.find((x) => x.symbol === "AMD")!;
    assert.equal(amd.group, "sector");
    assert.ok(amd.values.pe_ttm !== null && amd.values.volatility_1y !== null && amd.values.beta_spy_1y !== null);
    const qcom = r.rows.find((x) => x.symbol === "QCOM")!;
    assert.equal(qcom.status, "failed");
    assert.match(qcom.error!, /not found in the SEC registry/u);
  });

  it("registry outage fails every sector peer visibly; subjects without a list return none", async () => {
    const r = await gatherSectorPeers("NVDA", { fetchImpl: makeFetch(newNet({ fail: { sec: true } })), spyBars: [] });
    assert.ok(r.rows.length === SECTOR_PEERS.NVDA!.tickers.length && r.rows.every((x) => x.status === "failed"));
    assert.deepEqual(await gatherSectorPeers("SPY", { spyBars: [] }), { sector: null, rows: [] });
  });

  it("pipeline merges universe + sector peers and stays reproducible", async () => {
    const market = fakeMarket(Object.fromEntries([...STOCKS, "QQQ", "SPY", "AMD", "AVGO", "INTC"].map((s, i) => [s, 0.8 + i * 0.05])));
    const run = await runAssessment({ underlying: "NVDA" }, { now, fetchImpl: makeFetch(newNet({ market })) });
    assert.ok(run.peers.peer_set.includes("AMD"));
    assert.equal(run.peers.sector, "Semiconductors");
    assert.ok(run.peers.excluded.some((e) => e.symbol === "QCOM"));
    const again = await runAssessment({ underlying: "NVDA" }, { now, snapshot: run.market.snapshot, peerRows: run.peers.rows });
    assert.equal(again.hashes.calculation_hash, run.hashes.calculation_hash);
  });
});

import { deflateRawSync } from "node:zlib";
import { parseHoldingsXlsx } from "../src/sentinel/holdings.js";

function zip(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [], central: Buffer[] = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(text));
    const nb = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(text.length, 22); lh.writeUInt16LE(nb.length, 26);
    parts.push(lh, nb, data);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(text.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, nb);
    off += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}
function workbook(n: number): Buffer {
  const strings = ["Name", "Ticker", "Weight", "As of 15-Oct-2026", ...Array.from({ length: n }, (_, i) => `Co ${i} &amp; Sons`), ...Array.from({ length: n }, (_, i) => `T${i}`)];
  const sst = `<sst>${strings.map((x) => `<si><t>${x}</t></si>`).join("")}</sst>`;
  const hdr = `<row r="1"><c r="A1" t="s"><v>3</v></c></row><row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2" t="s"><v>1</v></c><c r="C2" t="s"><v>2</v></c></row>`;
  const rows = Array.from({ length: n }, (_, i) => `<row r="${i + 3}"><c r="A${i + 3}" t="s"><v>${4 + i}</v></c><c r="B${i + 3}" t="s"><v>${4 + n + i}</v></c><c r="C${i + 3}"><v>${i === 0 ? 10 : 90 / (n - 1)}</v></c></row>`).join("");
  return zip({ "xl/sharedStrings.xml": sst, "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${hdr}${rows}</sheetData></worksheet>` });
}

describe("ETF look-through and effective exposure", () => {
  it("parses an issuer xlsx (deflate), unescapes names, normalises weights", () => {
    const h = parseHoldingsXlsx(workbook(60), "SPY", "https://issuer.example/spy.xlsx");
    assert.equal(h.count, 60);
    assert.equal(h.as_of, "15-Oct-2026");
    assert.equal(h.holdings[0]!.ticker, "T0");
    assert.equal(h.holdings[0]!.weight, 0.1);
    assert.equal(h.holdings[1]!.name.includes("&amp;"), false);
    assert.ok(Math.abs(h.total_weight - 1) < 1e-6);
    assert.throws(() => parseHoldingsXlsx(workbook(10), "SPY", "u"), /only 10 holdings/u);
    assert.throws(() => parseHoldingsXlsx(Buffer.from("nope"), "SPY", "u"), /not a zip/u);
  });

  it("portfolio quantifies look-through overlap; unavailable look-through is stated, never guessed", async () => {
    const p = parseHoldingsXlsx(workbook(60), "SPY", "u");
    const spyHoldings = p.holdings.map((x, i) => ({ ...x, ticker: i === 0 ? "NVDA" : x.ticker }));
    const hs = parseHoldings([{ symbol: "NVDA", value_usd: 5000 }, { symbol: "SPY", value_usd: 5000 }]);
    assert.ok(hs.ok);
    const data = await fetchHoldingBars(hs.holdings, { now, fetchImpl: makeFetch(newNet({ market: allMarket() })) });
    const ok = analyzePortfolio(hs.holdings, { ...data, etfs: [{ etf: "SPY", status: "ok", as_of: "x", reason: null, holdings: spyHoldings }] });
    const nv = ok.effective_exposure.find((x) => x.ticker === "NVDA")!;
    assert.equal(nv.direct, 0.5);
    assert.equal(nv.via_etf, 0.05);
    assert.equal(nv.total, 0.55);
    assert.ok(ok.concentration.flags.some((f) => /Including look-through, NVDA is 55\.0%/u.test(f)));
    const un = analyzePortfolio(hs.holdings, { ...data, etfs: [{ etf: "SPY", status: "unavailable", as_of: null, reason: "HTTP 500", holdings: [] }] });
    assert.equal(un.effective_exposure.find((x) => x.ticker === "NVDA")!.via_etf, 0);
    assert.ok(un.notes.some((n) => /look-through unavailable/u.test(n)));
    assert.ok(un.concentration.flags.some((f) => /look-through is unavailable/u.test(f)));
  });
});

import { SYMBOLS, UNIVERSE, loadExtraAssets, registerAsset } from "../src/sentinel/types.js";
import { validateDossier } from "../src/sentinel/pipeline.js";

describe("asset registry (extensibility)", () => {
  it("registers extra stocks/ETFs with validation; core symbols are protected", () => {
    assert.equal(registerAsset("AMD", { name: "Advanced Micro Devices", kind: "stock", cik: 2488 }), null);
    assert.ok(SYMBOLS.includes("AMD") && UNIVERSE.AMD!.cik === 2488);
    assert.match(registerAsset("NVDA", { name: "x", kind: "stock", cik: 1 })!, /core symbol/u);
    assert.match(registerAsset("bad ticker", { name: "x", kind: "stock", cik: 1 })!, /not a valid ticker/u);
    assert.match(registerAsset("ZZA", { name: "x", kind: "stock", cik: null })!, /needs its SEC CIK/u);
    assert.match(registerAsset("ZZB", { name: "x", kind: "etf", cik: 5 })!, /cik must be null/u);
    assert.match(registerAsset("ZZC", { name: "x", kind: "bond" as never, cik: null })!, /kind must be/u);
    assert.equal(registerAsset("IWM", { name: "iShares Russell 2000 ETF", kind: "etf", cik: null }), null);
  });

  it("dossiers accept registered underlyings and reject unknown ones", () => {
    assert.equal(validateDossier({ underlying: "AMD" }).ok, true);
    const bad = validateDossier({ underlying: "DOGE" });
    assert.equal(bad.ok, false);
  });

  it("loadExtraAssets reads the env config and reports bad entries", () => {
    const errs = loadExtraAssets({ SENTINEL_EXTRA_ASSETS_JSON: '{"qqq":{"name":"x","kind":"etf","cik":null},"XOM":{"name":"Exxon Mobil","kind":"stock","cik":34088}}' } as never);
    assert.equal(errs.length, 1);
    assert.match(errs[0]!, /core symbol/u);
    assert.ok(UNIVERSE.XOM);
    assert.match(loadExtraAssets({ SENTINEL_EXTRA_ASSETS_JSON: "{oops" } as never)[0]!, /not valid JSON/u);
  });
});

describe("official SEC classification of peers", () => {
  it("attaches SIC codes, counts same/different/unknown, and survives reproduction", async () => {
    const base = makeFetch(newNet({ market: fakeMarket(Object.fromEntries([...STOCKS, "QQQ", "SPY", "AMD", "AVGO", "INTC"].map((x, i) => [x, 0.8 + i * 0.05]))) }));
    const sicOf: Record<string, [string, string]> = { "1045810": ["3674", "Semiconductors & Related Devices"], "2488": ["3674", "Semiconductors & Related Devices"], "320193": ["3571", "Electronic Computers"] };
    const f = (async (url: string, init?: any) => {
      const m = /submissions\/CIK0*(\d+)\.json/u.exec(url);
      if (m) { const s = sicOf[m[1]!]; return { ok: true, status: 200, json: async () => ({}), text: async () => JSON.stringify(s ? { sic: s[0], sicDescription: s[1] } : {}) }; }
      return base(url, init);
    }) as never;
    const r = await runAssessment({ underlying: "NVDA" }, { now, fetchImpl: f });
    assert.equal(r.peers.classification.subject.sic, "3674");
    assert.equal(r.peers.classification.peers.find((p) => p.symbol === "AMD")!.match, "same");
    assert.equal(r.peers.classification.peers.find((p) => p.symbol === "AAPL")!.match, "different");
    assert.ok(r.peers.classification.unknown >= 1, "peers without a retrievable code are unknown, never guessed");
    assert.match(renderReportHtml(r), /Official classification/u);
    assert.match(r.peers.comparability_note, /share the subject's SEC industry/u);
    const pe = r.peers.comparisons.find((c) => c.metric === "pe_ttm")!;
    assert.ok(pe.industry_count >= 0 && (pe.industry_median === null || pe.industry_count >= 3), "industry statistics only with at least 3 same-industry peers");
    const again = await runAssessment({ underlying: "NVDA" }, { now, snapshot: r.market.snapshot, peerRows: r.peers.rows });
    assert.equal(again.hashes.calculation_hash, r.hashes.calculation_hash);
    assert.equal(again.peers.classification.subject.sic, "3674");
  });
});
