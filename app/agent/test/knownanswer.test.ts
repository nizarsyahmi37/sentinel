/** Known-answer tests: expected values are computed by hand from the fixture inputs, not by the code under test. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runAssessment } from "../src/sentinel/pipeline.js";
import { FEED_ADDR, TOKEN_ADDR, makeFetch, newNet } from "./helpers.js";

const now = new Date("2026-10-17T03:00:00Z");

describe("known-answer metrics", () => {
  it("SEC fundamentals, token and valuation figures equal hand calculations", async () => {
    const net = newNet();
    const last = net.market!.assets.AAPL!.at(-1)!;
    // supply 1,000 tokens (18 dp), 2 tokens = 1 share; feed quotes exactly half the share price + 3%
    net.token = { address: TOKEN_ADDR, name: "T", symbol: "T", decimals: 18, totalSupply: 1000n * 10n ** 18n, feed: { address: FEED_ADDR, answer: (last / 2) * 1.03, decimals: 8, updatedAt: 1_792_149_000 } };
    const r = await runAssessment(
      { underlying: "AAPL", token: { chain: "bsc", contract_address: TOKEN_ADDR, tokens_per_share: 2, price_feed: FEED_ADDR }, claims: { shares_held_in_custody: 400 } },
      { now, fetchImpl: makeFetch(net), skipPeers: true },
    );
    const v = (id: string) => r.asset.metrics.find((m) => m.id === id)!.value!;
    const close = (a: number, b: number, tol = 1e-4) => assert.ok(Math.abs(a - b) <= Math.abs(b) * tol + 1e-9, `${a} !~ ${b}`);
    // fixture: revenue FY 400e9 + YTD 330e9 − prior YTD 300e9 = 430e9; EPS 6.5+5.0−4.5 = 7.0; OCF 110+95−85 = 120e9; capex 12+9−8 = 13e9; NI 100+90−80 = 110e9; shares 1e9
    assert.equal(v("revenue_ttm"), 430e9);
    assert.equal(v("eps_ttm"), 7);
    assert.equal(v("fcf_ttm"), 107e9);
    close(v("net_margin"), 110 / 430);
    close(v("market_cap"), last * 1e9);
    close(v("pe_ttm"), last / 7);
    close(v("ps_ttm"), (last * 1e9) / 430e9);
    // token: 1000 tokens ÷ 2 tokens/share = 500 implied shares; custody 400 → 0.8 collateral ratio
    close(v("token_underlying_shares_implied"), 500);
    close(v("backing_ratio"), 0.8);
    // premium = feed / (last ÷ 2) − 1 = 3%
    close(v("token_premium_discount"), 0.03, 1e-3);
  });

  it("price statistics on a deterministic 2-year series match closed forms", async () => {
    const net = newNet();
    const r = await runAssessment({ underlying: "AAPL" }, { now, fetchImpl: makeFetch(net), skipPeers: true });
    const px = net.market!.assets.AAPL!;
    const n = px.length;
    const v = (id: string) => r.asset.metrics.find((m) => m.id === id)!.value!;
    assert.ok(Math.abs(v("ret_12m") - (px[n - 1]! / px[n - 1 - 252]! - 1)) < 1e-5);
    assert.ok(Math.abs(v("ret_1m") - (px[n - 1]! / px[n - 1 - 21]! - 1)) < 1e-5);
    const w = px.slice(-253);
    const rets = w.slice(1).map((x, i) => x / w[i]! - 1);
    const m = rets.reduce((a, b) => a + b, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1));
    assert.ok(Math.abs(v("volatility_1y") - sd * Math.sqrt(252)) < 1e-5);
    let pk = 0, dd = 0;
    for (const x of px.slice(-252)) { pk = Math.max(pk, x); dd = Math.max(dd, 1 - x / pk); }
    assert.ok(Math.abs(v("max_drawdown_1y") - dd) < 1e-5);
  });
});
