import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runAssessment } from "../src/sentinel/pipeline.js";
import { makeFetch, newNet } from "./helpers.js";

const now = new Date("2026-10-17T03:00:00Z");
const base = { now, fetchImpl: makeFetch(newNet()), skipPeers: true } as const;
const pctText = (v: number) => `${Math.round(v * 10000) / 100}%`;

async function volText() {
  const r = await runAssessment({ underlying: "AAPL" }, base);
  return pctText(r.asset.metrics.find((m) => m.id === "volatility_1y")!.value!);
}
const good = (vol: string, ref = "volatility_1y", text?: string) =>
  JSON.stringify({
    thesis_summary: "The underlying shows moderate realised volatility but the token wrapper is unassessed, so the rule-based status stays at review until a contract and evidence are supplied.",
    supporting_factors: [{ text: text ?? `Annualised one-year volatility is ${vol}, a calculated figure from observed prices.`, refs: [ref] }],
    counterarguments: [{ text: "No token contract was supplied, so custody and redemption cannot be assessed.", refs: [] }, { text: "Prices come from an unofficial delayed source.", refs: [] }],
    additional_conditions: [],
  });

describe("LLM narrative guard (FR-10)", () => {
  it("no model configured → labelled template", async () => {
    const r = await runAssessment({ underlying: "AAPL" }, base);
    assert.equal(r.thesis.narrative_source, "template");
    assert.match(r.thesis.validation_notes.join(), /No language model/);
  });
  it("accepts a narrative whose figures all come from the facts", async () => {
    const vol = await volText();
    const r = await runAssessment({ underlying: "AAPL" }, { ...base, narrate: async () => good(vol) });
    assert.equal(r.thesis.narrative_source, "llm");
    assert.deepEqual(r.thesis.supporting_factors[0]!.basis, ["calculated"]);
  });
  it("rejects invented numbers, unknown refs and verification claims", async () => {
    const vol = await volText();
    for (const reply of [good(vol, "volatility_1y", "Volatility is 99.99%, which is extreme."), good(vol, "made_up_metric"), good(vol, "volatility_1y", `Custody is independently verified and returns are guaranteed with ${vol} volatility.`)]) {
      const r = await runAssessment({ underlying: "AAPL" }, { ...base, narrate: async () => reply });
      assert.equal(r.thesis.narrative_source, "template");
    }
  });
  it("recovers on the retry; a model failure never fails the report", async () => {
    const vol = await volText();
    let n = 0;
    const a = await runAssessment({ underlying: "AAPL" }, { ...base, narrate: async () => (++n === 1 ? "not json" : good(vol)) });
    assert.equal(a.thesis.narrative_source, "llm");
    const b = await runAssessment({ underlying: "AAPL" }, { ...base, narrate: async () => { throw new Error("down"); } });
    assert.equal(b.thesis.narrative_source, "template");
  });
  it("the narrative never changes the status or any calculation", async () => {
    const vol = await volText();
    const a = await runAssessment({ underlying: "AAPL" }, base);
    const b = await runAssessment({ underlying: "AAPL" }, { ...base, snapshot: a.market.snapshot, narrate: async () => good(vol) });
    assert.equal(a.assessment.status, b.assessment.status);
    assert.equal(a.hashes.calculation_hash, b.hashes.calculation_hash);
  });
});
