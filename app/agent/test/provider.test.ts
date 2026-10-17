import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { runAssessment } from "../src/sentinel/pipeline.js";
import { parsePolygon } from "../src/sentinel/sources.js";
import type { FetchLike } from "../src/sentinel/sources.js";
import { makeFetch, newNet, weekdays } from "./helpers.js";

const now = new Date("2026-10-17T03:00:00Z");
const KEY = "pk_test_SECRET_123";
afterEach(() => { delete process.env.SENTINEL_PRICE_PROVIDER; delete process.env.POLYGON_API_KEY; });

function withPolygon(net = newNet(), opts: { fail?: boolean } = {}) {
  const base = makeFetch(net);
  const seen: { url: string; auth?: string }[] = [];
  const f: FetchLike = async (url, init) => {
    if (url.includes("api.polygon.io")) {
      seen.push({ url, auth: init?.headers?.authorization });
      if (opts.fail) return { ok: false, status: 429, json: async () => ({}), text: async () => "" };
      if (url.includes("/v3/reference/dividends")) return { ok: true, status: 200, json: async () => ({}), text: async () => JSON.stringify({ status: "OK", results: [{ ex_dividend_date: "2026-08-10", cash_amount: 0.25 }] }) };
      const sym = /ticker\/([A-Z]+)\//u.exec(url)![1]!;
      const m = net.market!;
      const closes = sym === "SPY" ? m.spy : m.assets[sym]!;
      const results = m.dates.map((d, i) => ({ t: Date.parse(`${d}T04:00:00Z`), c: closes[i], v: 1_000_000 }));
      return { ok: true, status: 200, json: async () => ({}), text: async () => JSON.stringify({ status: "OK", results }) };
    }
    if (url.includes("finance.yahoo.com") && !opts.fail && process.env.POLYGON_API_KEY) throw new Error("Yahoo must not be called when the licensed feed works");
    return base(url, init);
  };
  return { f, seen };
}

describe("licensed price provider (Polygon.io)", () => {
  it("parses aggregates, skips bad rows, sorts by date", () => {
    const p = parsePolygon("AAPL", JSON.stringify({ status: "OK", results: [{ t: Date.parse("2026-10-02T04:00:00Z"), c: 11, v: 5 }, { t: Date.parse("2026-10-01T04:00:00Z"), c: 10 }, { t: 1, c: -3 }] }), "u");
    assert.deepEqual(p.bars.map((b) => [b.date, b.close]), [["2026-10-01", 10], ["2026-10-02", 11]]);
    assert.equal(p.provider, "polygon");
    assert.throws(() => parsePolygon("AAPL", JSON.stringify({ status: "ERROR", error: "bad key" }), "u"), /bad key/u);
    assert.throws(() => parsePolygon("AAPL", JSON.stringify({ status: "OK", results: [] }), "u"), /no usable/u);
  });

  it("uses the licensed feed, labels it, sends the key only as a header and never leaks it", async () => {
    process.env.SENTINEL_PRICE_PROVIDER = "polygon";
    process.env.POLYGON_API_KEY = KEY;
    const { f, seen } = withPolygon();
    const r = await runAssessment({ underlying: "AAPL" }, { now, fetchImpl: f, skipPeers: true });
    assert.ok(seen.length >= 2 && seen.every((s) => s.auth === `Bearer ${KEY}` && !s.url.includes(KEY)));
    assert.ok(r.market.snapshot.sources.some((s) => s.source_id === "polygon_AAPL" && /licensed API/u.test(s.name)));
    assert.ok(!r.market.snapshot.sources.some((s) => s.source_id.startsWith("yahoo_")));
    assert.ok(!r.limitations.some((l) => /unofficial source/u.test(l)), "no unofficial-source warning when the feed is licensed");
    assert.match(r.asset_overview.exchange_note, /Polygon\.io/u);
    assert.ok(!JSON.stringify(r).includes(KEY), "the API key is not in the report");
    assert.ok(r.asset.metrics.find((m) => m.id === "dividend_yield_ttm")!.status === "OK");
  });

  it("licensed feed down → falls back to Yahoo and says so; no key → says so", async () => {
    process.env.SENTINEL_PRICE_PROVIDER = "polygon";
    process.env.POLYGON_API_KEY = KEY;
    const bad = withPolygon(newNet(), { fail: true });
    const r = await runAssessment({ underlying: "AAPL" }, { now, fetchImpl: bad.f, skipPeers: true });
    assert.ok(r.market.snapshot.sources.some((s) => s.source_id === "yahoo_AAPL"));
    assert.ok(r.market.snapshot.limitations.some((l) => /Licensed price feed \(Polygon\.io\) failed.*Yahoo/u.test(l)));
    assert.ok(r.limitations.some((l) => /unofficial source/u.test(l)));
    delete process.env.POLYGON_API_KEY;
    const r2 = await runAssessment({ underlying: "AAPL" }, { now, fetchImpl: makeFetch(newNet()), skipPeers: true });
    assert.ok(r2.market.snapshot.limitations.some((l) => /POLYGON_API_KEY is not set/u.test(l)));
  });
});
