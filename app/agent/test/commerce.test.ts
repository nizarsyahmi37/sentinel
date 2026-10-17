import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SellerCore, type SigningApi } from "../src/sellerCore.js";
import { TaskError, createSentinelWork, parseTask, precheckTask, recordSubmit, taskFromPrompt, type CommerceEnv } from "../src/sentinel/commerce.js";
import { Store } from "../src/sentinel/store.js";
import { makeFetch, newNet } from "./helpers.js";

function env(): CommerceEnv {
  return { store: new Store(mkdtempSync(path.join(tmpdir(), "sc-"))), tenant: "public", now: () => new Date("2026-10-17T03:00:00Z"), fetchImpl: makeFetch(newNet()), skipPeers: true };
}
const prompt = (task: string) => `You accepted…\n\nJOB CONTEXT:\n${JSON.stringify({ task, terms: {} })}`;

describe("task parsing", () => {
  it("accepts equity alias, inline dossier, wrapped dossier, asset reference", () => {
    assert.equal(parseTask("equity:NVDA").kind, "dossier");
    assert.equal(parseTask(JSON.stringify({ underlying: "MSFT" })).kind, "dossier");
    assert.equal(parseTask(JSON.stringify({ sentinel: "v1", dossier: { underlying: "QQQ" } })).kind, "dossier");
    assert.deepEqual(parseTask('{"sentinel":"v1","asset_id":"abc"}'), { kind: "asset", asset_id: "abc" });
  });
  it("rejects prose, unsupported tickers and invalid dossiers before funding", () => {
    for (const t of ["write me a poem", "", "equity:ZZZ", '{"underlying":"AAPL","claims":{"custodian":"x"}}']) assert.throws(() => parseTask(t), TaskError, t);
  });
  it("negotiate precheck refuses unregistered assets", () => {
    const e = env();
    assert.throws(() => precheckTask('{"sentinel":"v1","asset_id":"nope"}', e.store, "public"), /not registered/);
    assert.doesNotThrow(() => precheckTask("equity:AAPL", e.store, "public"));
  });
  it("extracts the task from the runtime prompt", () => {
    assert.equal(taskFromPrompt(prompt("equity:AAPL")), "equity:AAPL");
    assert.equal(taskFromPrompt("equity:AAPL"), "equity:AAPL");
  });
});

describe("paid-task delivery", () => {
  it("delivers a hash-bearing report from real-shaped data; one analysis per job; idempotent", async () => {
    const e = env();
    const work = createSentinelWork(e);
    const a = await work(prompt("equity:AAPL"), { sessionId: "42" });
    const b = await work(prompt("equity:AAPL"), { sessionId: "42" });
    assert.equal(a, b);
    const payload = JSON.parse(a);
    assert.equal(payload.sentinel.service_id, "sentinel.tokenized-equity-assessment");
    assert.equal(payload.sentinel.report_hash, payload.report.hashes.report_hash);
    assert.equal(e.store.listAnalyses("public").filter((x) => x.task?.job_id === "42").length, 1);
    assert.notEqual(JSON.parse(await work(prompt("equity:AAPL"), { sessionId: "43" })).sentinel.analysis_id, payload.sentinel.analysis_id);
    assert.equal(e.store.findAnalysisByJob("public", "42")?.task?.status, "DELIVERED");
  });
  it("a bad task throws — nothing is delivered", async () => {
    const e = env();
    await assert.rejects(createSentinelWork(e)(prompt("not a dossier"), { sessionId: "7" }), TaskError);
    assert.equal(e.store.listAnalyses("public").length, 0);
  });
  it("a data outage fails the job (refund path) instead of delivering a hollow report", async () => {
    const e = { ...env(), fetchImpl: makeFetch(newNet({ fail: { yahoo: true, fred: true, sec: true, rpc: true } })) };
    await assert.rejects(createSentinelWork(e)(prompt("equity:AAPL"), { sessionId: "9" }), /no deliverable submitted/);
    assert.equal(e.store.findAnalysisByJob("public", "9")?.task?.status, "FAILED");
  });
  it("records the real submit tx only after submitResult succeeds", async () => {
    const e = env();
    const work = createSentinelWork(e);
    let submitted = 0;
    const signing: SigningApi = {
      listPrice: () => 1n, clampPrice: (x) => x, signQuote: async () => ({}),
      verifySignedJob: async () => ({ ok: true, reason: "", permanent: false }),
      jobSpec: async () => ({ task: "equity:AAPL", terms: {} }),
      submitResult: async (jobId, content) => {
        submitted++;
        assert.ok(JSON.parse(content).report.hashes.calculation_hash);
        const r = { submitTx: "0xabc123", deliverableUrl: "https://example.test/deliverable" };
        recordSubmit(e, jobId, r);
        return r;
      },
    };
    const core = new SellerCore({ runWork: work, generator: "sentinel", signing, pendingJobs: async () => ({}) });
    assert.equal((await core.notifyFunded({ job_id: 99 })).status, "accepted");
    await core.drain();
    assert.equal(submitted, 1);
    const rec = e.store.findAnalysisByJob("public", "99")!;
    assert.equal(rec.task?.status, "SUBMITTED");
    assert.equal(rec.task?.tx_hash, "0xabc123");
  });
  it("an invalid task is never submitted on-chain", async () => {
    const e = env();
    let submitted = 0;
    const signing: SigningApi = {
      listPrice: () => 1n, clampPrice: (x) => x, signQuote: async () => ({}),
      verifySignedJob: async () => ({ ok: true, reason: "", permanent: false }),
      jobSpec: async () => ({ task: "garbage", terms: {} }),
      submitResult: async () => { submitted++; return { submitTx: "0x", deliverableUrl: null }; },
    };
    const core = new SellerCore({ runWork: createSentinelWork(e), generator: "sentinel", signing, pendingJobs: async () => ({}) });
    await core.notifyFunded({ job_id: 5 });
    await core.drain();
    assert.equal(submitted, 0);
  });
});
