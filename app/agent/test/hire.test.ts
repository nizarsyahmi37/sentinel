import { test } from "node:test";
import assert from "node:assert/strict";
import { createHirer, hireConfigFromEnv, isLoopback, type HireConfig, type HireExec } from "../src/sentinel/hire.js";
import type { FetchLike } from "../src/sentinel/sources.js";

const cfg: HireConfig = {
  buyerDir: "/tmp/buyer", platform: "https://platform.test", agentId: "AGENT", clientId: "id", clientSecret: "secret",
  provider: "0x6571415fc43208726012226C419a29d3C982e2C3", priceUsd: "0.10", network: "bsc-testnet",
  currency: "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565", maxHires: 2, bagBin: "bag",
};
const U = cfg.currency;

function fakeFetch(opts: { price?: string; currency?: string; accepted?: boolean; ack?: string; log?: string[] } = {}): FetchLike {
  return async (url, init) => {
    opts.log?.push(url);
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => "" });
    if (url.endsWith("/oauth/token")) return ok({ access_token: "tok" });
    const sent = JSON.parse(init?.body ?? "{}") as { params: { message: { parts: { data: { skill: string } }[] } } };
    const skill = sent.params.message.parts[0]!.data.skill;
    if (skill === "negotiate") return ok({ result: { parts: [{ data: { response: { accepted: opts.accepted ?? true, terms: { price: opts.price ?? "100000000000000000", currency: opts.currency ?? U } } } }] } });
    return ok({ result: { parts: [{ data: { status: opts.ack ?? "accepted", job_id: 1 } }] } });
  };
}
const okExec = (calls: { args: string[]; env: Record<string, string> }[] = []): HireExec => async (_b, args, o) => {
  calls.push({ args, env: o.env });
  return { stdout: "negotiated_price_u: 0.1\njob_id:             4242\nfund_tx: 0xabc\n" };
};
const settle = async (h: ReturnType<typeof createHirer>, id: string) => {
  for (let i = 0; i < 50 && h.get(id)?.status === "running"; i++) await new Promise((r) => setTimeout(r, 5));
  return h.get(id)!;
};

test("hire: negotiate → buy → notify; the child gets a minimal env and a fixed provider", async () => {
  const calls: { args: string[]; env: Record<string, string> }[] = [];
  const h = createHirer(cfg, { fetch: fakeFetch(), exec: okExec(calls) });
  const run = await settle(h, h.start("equity:nvda").hire_id);
  assert.equal(run.status, "submitted");
  assert.equal(run.job_id, 4242);
  assert.equal(run.task, "equity:NVDA");
  assert.ok(run.steps.every((s) => s.status === "done"));
  const a = calls[0]!.args;
  assert.deepEqual(a.slice(0, 2), ["erc8183", "buy"]);
  assert.equal(a[a.indexOf("--provider") + 1], cfg.provider);
  assert.deepEqual(Object.keys(calls[0]!.env).sort(), ["HOME", "PATH"]); // no seller secrets reach the buyer CLI
});

test("hire: a quote above the service price, or the wrong token, is refused BEFORE funding", async () => {
  for (const f of [fakeFetch({ price: "200000000000000000" }), fakeFetch({ currency: "0x0000000000000000000000000000000000000001" }), fakeFetch({ accepted: false })]) {
    const calls: { args: string[]; env: Record<string, string> }[] = [];
    const h = createHirer(cfg, { fetch: f, exec: okExec(calls) });
    const run = await settle(h, h.start("equity:AAPL").hire_id);
    assert.equal(run.status, "failed");
    assert.equal(calls.length, 0, "the buyer CLI must not run");
    assert.equal(run.steps[1]!.status, "failed");
  }
});

test("hire: failures in the buyer CLI or the notify step are reported honestly", async () => {
  const bad: HireExec = async () => { throw new Error("insufficient funds"); };
  const h1 = createHirer(cfg, { fetch: fakeFetch(), exec: bad });
  const r1 = await settle(h1, h1.start("equity:AAPL").hire_id);
  assert.equal(r1.status, "failed");
  assert.match(r1.error ?? "", /insufficient funds/u);
  const h2 = createHirer(cfg, { fetch: fakeFetch({ ack: "rejected" }), exec: okExec() });
  const r2 = await settle(h2, h2.start("equity:AAPL").hire_id);
  assert.equal(r2.status, "failed");
  assert.equal(r2.job_id, 4242); // the job exists on-chain even though delivery was not accepted
});

test("hire: bad task, one at a time, and a hard cap per process", async () => {
  const h = createHirer(cfg, { fetch: fakeFetch(), exec: okExec() });
  for (const t of ["", "NVDA", "equity:", "equity:TOOLONGSYM", "{\"sentinel\":\"v1\"}", "equity:AAPL; rm -rf /"]) assert.throws(() => h.start(t), (e: { code?: number }) => e.code === 422);
  const first = h.start("equity:AAPL");
  assert.throws(() => h.start("equity:MSFT"), (e: { code?: number }) => e.code === 409);
  await settle(h, first.hire_id);
  await settle(h, h.start("equity:MSFT").hire_id);
  assert.throws(() => h.start("equity:SPY"), (e: { code?: number }) => e.code === 429); // maxHires = 2
});

test("hire: disabled unless a buyer project and OAuth client are configured; loopback only", () => {
  const svc = { agent_address: cfg.provider, price_usd: "0.10", network: "bsc-testnet" };
  assert.equal(hireConfigFromEnv({}, svc), null);
  assert.equal(hireConfigFromEnv({ SENTINEL_HIRE_BUYER_DIR: "/b" }, svc), null);
  assert.ok(hireConfigFromEnv({ SENTINEL_HIRE_BUYER_DIR: "/b", SENTINEL_CLIENT_ID: "i", SENTINEL_CLIENT_SECRET: "s" }, svc));
  assert.equal(hireConfigFromEnv({ SENTINEL_HIRE_BUYER_DIR: "/b", SENTINEL_CLIENT_ID: "i", SENTINEL_CLIENT_SECRET: "s" }, { ...svc, agent_address: null }), null);
  assert.equal(isLoopback("127.0.0.1"), true);
  assert.equal(isLoopback("::1"), true);
  assert.equal(isLoopback("10.0.0.5"), false);
  assert.equal(isLoopback(undefined), false);
});
