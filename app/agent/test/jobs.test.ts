import { test } from "node:test";
import assert from "node:assert/strict";
import { listProviderJobs, readJob } from "../src/sentinel/jobs.js";
import type { FetchLike } from "../src/sentinel/sources.js";

const word = (v: bigint | string): string => (typeof v === "bigint" ? v.toString(16) : v.replace(/^0x/u, "")).padStart(64, "0");
const CLIENT = "0x1ef4f8706b6d39149b52974f29b68783b6003b7c";
const PROVIDER = "0x6571415fc43208726012226c419a29d3c982e2c3";

function jobResult(id: bigint, status: bigint, deliverable = 0n): string {
  // tuple offset, then id, client, provider, evaluator, description offset, budget, expiredAt, status, hook, submittedAt, deliverable
  const words = [word(0x20n), word(id), word(CLIENT), word(PROVIDER), word(PROVIDER), word(0x180n), word(10n ** 17n), word(1792214639n), word(status), word(0n), word(status >= 2n ? 1792212122n : 0n), word(deliverable)];
  return "0x" + words.join("") + word(0n) + word(0n);
}

const fakeChain = (result: string | null): FetchLike => async (_url, init) => {
  const body = JSON.parse(init?.body ?? "{}") as { method: string; params: { data: string }[] };
  assert.equal(body.method, "eth_call");
  assert.match(body.params[0]!.data, /^0xbf22c457/u); // getJob(uint256)
  return { ok: true, status: 200, json: async () => (result === null ? { error: { message: "execution reverted" } } : { result }), text: async () => "" };
};

test("readJob decodes a completed job and flags the payment as released", async () => {
  const j = await readJob(fakeChain(jobResult(1531n, 3n, 0xabcn)), "bsc-testnet", 1531);
  assert.ok(j);
  assert.equal(j.status, "COMPLETED");
  assert.equal(j.paid_to_provider, true);
  assert.equal(j.budget_u, "0.1");
  assert.equal(j.client.toLowerCase(), CLIENT);
  assert.equal(j.provider.toLowerCase(), PROVIDER);
  assert.match(j.deliverable_hash ?? "", /abc$/u);
  assert.ok(j.submitted_at);
});

test("readJob: a funded job is not paid and has no deliverable; a wrong id is not found", async () => {
  const funded = await readJob(fakeChain(jobResult(7n, 1n)), "bsc-testnet", 7);
  assert.equal(funded?.status, "FUNDED");
  assert.equal(funded?.paid_to_provider, false);
  assert.equal(funded?.deliverable_hash, null);
  assert.equal(funded?.submitted_at, null);
  assert.equal(await readJob(fakeChain(jobResult(8n, 3n)), "bsc-testnet", 9), null); // id mismatch
  assert.equal(await readJob(fakeChain("0x"), "bsc-testnet", 1), null);
});

test("readJob surfaces an RPC failure instead of inventing a job", async () => {
  await assert.rejects(readJob(fakeChain(null), "bsc-testnet", 1));
});

test("listProviderJobs: reads JobFunded events for the provider, newest first, with each job's state", async () => {
  const seen: string[] = [];
  const fake: FetchLike = async (_url, init) => {
    const b = JSON.parse(init?.body ?? "{}") as { method: string; params: { topics?: (string | null)[]; data?: string }[] };
    seen.push(b.method);
    const ok = (result: unknown) => ({ ok: true, status: 200, json: async () => ({ result }), text: async () => "" });
    if (b.method === "eth_blockNumber") return ok("0x186a0");
    if (b.method === "eth_getLogs") {
      assert.equal(b.params[0]!.topics![3], "0x" + "0".repeat(24) + PROVIDER.slice(2)); // filtered by provider
      return ok([{ topics: ["0xt", "0x" + (5).toString(16).padStart(64, "0")], blockNumber: "0x10" }, { topics: ["0xt", "0x" + (9).toString(16).padStart(64, "0")], blockNumber: "0x20" }]);
    }
    const id = BigInt("0x" + (b.params[0]!.data ?? "").slice(10));
    return ok(jobResult(id, id === 9n ? 3n : 1n));
  };
  const jobs = await listProviderJobs(fake, "bsc-testnet", "0x" + PROVIDER.slice(2), { windows: 1 });
  assert.deepEqual(jobs.map((j) => [j.job_id, j.status]), [[9, "COMPLETED"], [5, "FUNDED"]]);
  assert.equal(jobs[0]!.paid_to_provider, true);
  assert.ok(seen.includes("eth_getLogs"));
});
