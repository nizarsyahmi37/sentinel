import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  alignBars, annualizedVol, beta, correlation, historicalVar, maxDrawdown, percentile, periodReturn, simpleReturns, sma, stdev, worstRolling,
} from "../src/sentinel/stats.js";
import { extractFundamentals, fetchFred, fetchPrices, ttm } from "../src/sentinel/sources.js";
import { decodeInt, decodeString, decodeUint, makeRpc, readToken } from "../src/sentinel/chain.js";
import { FEED_ADDR, IMPL_ADDR, OWNER_ADDR, TOKEN_ADDR, fakeSecWithPriorFy, lcg, makeFetch, newNet } from "./helpers.js";

describe("statistics: known answers", () => {
  it("returns, stdev, period return", () => {
    assert.deepEqual(simpleReturns([100, 110, 99]).map((x) => Math.round(x * 1e6) / 1e6), [0.1, -0.1]);
    assert.equal(stdev([1, 2, 3, 4]), Math.sqrt(5 / 3));
    assert.equal(periodReturn([100, 105, 110], 2), 0.1);
    assert.equal(periodReturn([100], 5), null);
  });
  it("max drawdown = 25% for 120 → 90", () => {
    const p = [...Array(20).fill(100), ...Array(10).fill(120), ...Array(10).fill(90)];
    assert.equal(maxDrawdown(p), 0.25);
    assert.equal(maxDrawdown([100, 90]), null);
  });
  it("percentile, sma", () => {
    assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
    assert.equal(percentile([1, 2, 3, 4, 5], 0.25), 2);
    assert.equal(sma([1, 2, 3, 4], 2), 3.5);
    assert.equal(sma([1], 2), null);
  });
  it("beta and correlation recover a known linear relation", () => {
    const r = lcg(7);
    const m = Array.from({ length: 200 }, () => (r() - 0.5) * 0.02);
    const a = m.map((x) => 2 * x);
    assert.ok(Math.abs((beta(a, m) as number) - 2) < 1e-4);
    assert.equal(correlation(a, m), 1);
    assert.equal(beta([0.1], [0.1]), null);
  });
  it("VaR and worst rolling return are sane", () => {
    const r = lcg(3);
    let p = 100;
    const prices = Array.from({ length: 400 }, () => (p *= 1 + (r() - 0.5) * 0.04));
    const v = historicalVar(prices, 0.05)!;
    assert.ok(v > 0 && v < 0.05);
    assert.ok(worstRolling(prices, 20)! < 0);
    assert.ok(annualizedVol(prices)! > 0);
  });
  it("alignBars matches on date", () => {
    const a = [{ date: "d1", close: 1, adj: 1, volume: 1 }, { date: "d2", close: 2, adj: 2, volume: 1 }];
    const b = [{ date: "d2", close: 5, adj: 5, volume: 1 }, { date: "d3", close: 6, adj: 6, volume: 1 }];
    assert.deepEqual(alignBars(a, b), { dates: ["d2"], a: [2], b: [5] });
  });
});

describe("sources: parsing real-shaped payloads", () => {
  const net = newNet();
  const f = makeFetch(net);
  it("Yahoo → bars, dividends, last price", async () => {
    const ph = await fetchPrices(f, "AAPL");
    assert.equal(ph.bars.length, 520);
    assert.equal(ph.dividends.length, 4);
    assert.ok(ph.last_price > 0);
    assert.match(ph.url, /query1\.finance\.yahoo\.com/);
  });
  it("Yahoo errors surface as SourceError, never as fake data", async () => {
    await assert.rejects(fetchPrices(makeFetch(newNet({ fail: { yahoo: true } })), "AAPL"), /Yahoo Finance: HTTP 503/);
    await assert.rejects(fetchPrices(makeFetch(newNet()), "ZZZZ"), /Yahoo Finance/);
  });
  it("FRED skips missing observations", async () => {
    const r = await fetchFred(f, "DGS10", new Date("2026-10-17T00:00:00Z"));
    assert.equal(r.series.at(-1)!.date, "2026-10-13");
    assert.ok(r.series.every((p) => Number.isFinite(p.value)));
  });
});

describe("SEC fundamentals", () => {
  const facts = extractFundamentals(fakeSecWithPriorFy(), 320193);
  const it_ = (k: string) => facts.items[k]!;
  it("TTM = FY + YTD − prior-year YTD", () => {
    assert.equal(it_("revenue").value, 430e9);
    assert.equal(it_("revenue").basis, "TTM");
    assert.equal(it_("net_income").value, 110e9);
    assert.equal(it_("eps_diluted").value, 7);
    assert.equal(it_("ocf").value, 120e9);
    assert.equal(it_("capex").value, 13e9);
  });
  it("records provenance and the latest restated comparative", () => {
    assert.equal(it_("revenue").accession, "0000320193-26-000020");
    assert.equal(it_("revenue").form, "10-Q");
    assert.equal(facts.latest_filed, "2026-07-31");
  });
  it("instants, shares and fiscal-year growth inputs", () => {
    assert.equal(it_("cash").value, 40e9);
    assert.equal(it_("debt").value, 80e9);
    assert.equal(it_("shares_outstanding").value, 1_000_000_000);
    assert.equal(it_("revenue_fy").value, 400e9);
    assert.equal(it_("revenue_fy_prior").value, 380e9);
  });
  it("falls back to the latest FY when no YTD pair exists", () => {
    const r = ttm([{ start: "2024-09-29", end: "2025-09-27", val: 100, accn: "a", form: "10-K", filed: "2025-10-31" }]);
    assert.equal(r?.basis, "FY");
    assert.equal(r?.value, 100);
  });
  it("missing tags are simply absent (nothing imputed)", () => {
    const x = extractFundamentals({ facts: { "us-gaap": {} } }, 1);
    assert.deepEqual(Object.keys(x.items), []);
  });
});

describe("on-chain reads", () => {
  const spec = { address: TOKEN_ADDR, name: "Apple (Ondo Tokenized)", symbol: "AAPLon", decimals: 18, totalSupply: 1_000_000_000_000_000_000_000n, owner: OWNER_ADDR, ownerIsContract: false, pausable: true, paused: false, implementation: IMPL_ADDR, admin: OWNER_ADDR, feed: { address: FEED_ADDR, answer: 250.5, decimals: 8, updatedAt: 1_792_149_000 } };
  it("decodes ABI values", () => {
    assert.equal(decodeUint("0x" + "0".repeat(63) + "5"), 5n);
    assert.equal(decodeInt("0x" + "f".repeat(64)), -1n);
    assert.equal(decodeString("0x" + "20".padStart(64, "0") + "3".padStart(64, "0") + Buffer.from("abc").toString("hex").padEnd(64, "0")), "abc");
  });
  it("reads name, symbol, decimals, supply, admin, upgradeability and the feed", async () => {
    const net = newNet({ token: spec });
    const { rpc, host } = makeRpc(makeFetch(net), "bsc");
    const t = await readToken(rpc, host(), "bsc", TOKEN_ADDR, FEED_ADDR);
    assert.equal(t.has_code, true);
    assert.equal(t.symbol, "AAPLon");
    assert.equal(t.decimals, 18);
    assert.equal(t.total_supply, 1000);
    assert.equal(t.owner?.toLowerCase(), OWNER_ADDR);
    assert.equal(t.owner_is_contract, false);
    assert.equal(t.pausable, true);
    assert.equal(t.paused, false);
    assert.equal(t.implementation?.toLowerCase(), IMPL_ADDR);
    assert.equal(t.feed?.answer, 250.5);
    assert.deepEqual(t.errors, []);
  });
  it("an address with no code is reported, not guessed", async () => {
    const net = newNet({ token: { ...spec, code: false } });
    const { rpc, host } = makeRpc(makeFetch(net), "bsc");
    const t = await readToken(rpc, host(), "bsc", TOKEN_ADDR);
    assert.equal(t.has_code, false);
    assert.equal(t.symbol, null);
  });
  it("RPC outage throws instead of returning invented facts", async () => {
    const { rpc } = makeRpc(makeFetch(newNet({ fail: { rpc: true } })), "bsc");
    await assert.rejects(rpc("eth_getCode", ["0x0", "latest"]), /BSC RPC/);
  });
});
