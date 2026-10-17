import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHAINS, explorerUrl } from "../src/sentinel/chains.js";
import { rpcUrls } from "../src/sentinel/chain.js";
import { runAssessment, validateDossier } from "../src/sentinel/pipeline.js";
import { FEED_ADDR, TOKEN_ADDR, makeFetch, newNet } from "./helpers.js";

const now = new Date("2026-10-17T03:00:00Z");
const setup = (bytecode?: string) => {
  const net = newNet();
  net.token = { address: TOKEN_ADDR, name: "Apple (T)", symbol: "AAPLt", decimals: 18, totalSupply: 1000n * 10n ** 18n, bytecode, feed: { address: FEED_ADDR, answer: net.market!.assets.AAPL!.at(-1)!, decimals: 8, updatedAt: 1_792_149_000 } };
  return net;
};
const dossier = (chain = "bsc") => ({ underlying: "AAPL", token: { chain, contract_address: TOKEN_ADDR, price_feed: FEED_ADDR }, claims: { redemption: { available: true } } });

describe("multi-chain", () => {
  it("accepts the supported chains, rejects unknown ones, builds explorer links", () => {
    for (const c of Object.keys(CHAINS)) assert.equal(validateDossier(dossier(c)).ok, true, c);
    assert.equal(validateDossier(dossier("solana")).ok, false);
    assert.equal(explorerUrl("ethereum", "address", "0xabc"), "https://etherscan.io/address/0xabc");
    assert.equal(explorerUrl("arbitrum", "tx", "0x1"), "https://arbiscan.io/tx/0x1");
    assert.equal(explorerUrl("bsc-testnet", "address", "0x1"), "https://testnet.bscscan.com/address/0x1");
  });

  it("RPC override per chain via env; defaults otherwise", () => {
    assert.deepEqual(rpcUrls("ethereum"), CHAINS.ethereum!.rpcs);
    process.env.SENTINEL_ARBITRUM_RPC = "https://rpc.example.com";
    assert.deepEqual(rpcUrls("arbitrum"), ["https://rpc.example.com"]);
    delete process.env.SENTINEL_ARBITRUM_RPC;
  });

  it("a token on another chain is read and labelled with that chain", async () => {
    const r = await runAssessment(dossier("ethereum"), { now, fetchImpl: makeFetch(setup()), skipPeers: true });
    assert.ok(r.market.snapshot.sources.some((s) => /^Ethereum JSON-RPC/u.test(s.name)));
    assert.equal(r.asset_overview.token!.chain, "ethereum");
  });
});

describe("redemption-flow signals", () => {
  const SEL = { burn: "42966c68", redeem: "db006a75" };
  it("finds burn/redeem entry points in bytecode and says it is a capability signal", async () => {
    const r = await runAssessment(dossier(), { now, fetchImpl: makeFetch(setup(`0x6080604052${SEL.burn}${SEL.redeem}${"00".repeat(1600)}`)), skipPeers: true });
    const m = r.asset.metrics.find((x) => x.id === "redemption_entrypoints")!;
    assert.equal(m.value, 2);
    assert.ok(m.warnings.some((w) => /capability signal/u.test(w)));
    assert.ok(!r.risks.token.some((k) => k.category === "redemption_path"));
  });
  it("claims redeemable but no entry point → medium 'redemption_path' risk, stated as unobservable", async () => {
    const r = await runAssessment(dossier(), { now, fetchImpl: makeFetch(setup(`0x6080604052${"00".repeat(1600)}`)), skipPeers: true });
    assert.equal(r.asset.metrics.find((x) => x.id === "redemption_entrypoints")!.value, 0);
    const k = r.risks.token.find((x) => x.category === "redemption_path")!;
    assert.equal(k.severity, "medium");
    assert.match(k.description, /off-chain issuer process/u);
  });
  it("a tiny proxy whose implementation cannot be resolved is 'unknown', never 'none' — no false risk", async () => {
    const r = await runAssessment(dossier(), { now, fetchImpl: makeFetch(setup("0x6080604052")), skipPeers: true });
    const m = r.asset.metrics.find((x) => x.id === "redemption_entrypoints")!;
    assert.equal(m.value, null);
    assert.equal(m.status, "MISSING");
    assert.ok(!r.risks.token.some((k) => k.category === "redemption_path"));
  });
});
