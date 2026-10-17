import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateKeyPairSync, createSign, createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { OidcVerifier } from "../src/sentinel/oidc.js";
import { createApi, type ServiceInfo } from "../src/sentinel/service.js";
import { Store } from "../src/sentinel/store.js";
import { awaitApproval } from "../src/sentinel/commerce.js";
import { assertSafeWebhookUrl, dispatchWebhooks, isPrivateAddress, signPayload } from "../src/sentinel/webhooks.js";
import { fakeMarket, makeFetch, newNet } from "./helpers.js";

const info: ServiceInfo = { price_usd: "0.10", assets: ["TEST_U"], network: "bsc-testnet", agent_address: null, agent_id: null, agent_url: null, identity_tx: null, protocols: [], rails: [] };
const STOCKS = ["AAPL", "NVDA", "SPY", "QQQ"];
const net = () => newNet({ market: fakeMarket(Object.fromEntries(STOCKS.map((s, i) => [s, 0.9 + i * 0.1]))) });

type Extra = Partial<Parameters<typeof createApi>[0]>;
async function boot(extra: Extra = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "ph-"));
  const store = new Store(dir);
  let tick = 0;
  const app = express();
  app.use("/api/v1", createApi({ store, now: () => new Date(Date.UTC(2026, 9, 17, 3, 0, tick++)), fetchImpl: makeFetch(net()), skipPeers: true, serviceInfo: () => info, ...extra }));
  return new Promise<{ base: string; store: Store; close: () => void }>((resolve) => {
    const server = app.listen(0, () => resolve({ base: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`, store, close: () => { server.close(); rmSync(dir, { recursive: true, force: true }); } }));
  });
}
const call = async (method: string, url: string, key?: string, body?: unknown) => {
  const r = await fetch(url, { method, headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text, headers: r.headers };
};
const KEYS = ["kAdmin;tenant=acme;role=admin;user=root", "kAlice;tenant=acme;role=analyst;user=alice", "kBob;tenant=acme;role=analyst;user=bob", "kView;tenant=acme;role=viewer;user=vic"];

describe("webhooks", () => {
  it("blocks private/loopback/http/credential destinations", async () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.20.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:10.0.0.1", "100.64.0.1"]) assert.ok(isPrivateAddress(ip), ip);
    assert.ok(!isPrivateAddress("93.184.216.34"));
    const pub = async () => ["93.184.216.34"];
    await assert.rejects(assertSafeWebhookUrl("http://example.com/x", pub), /https/u);
    await assert.rejects(assertSafeWebhookUrl("https://user:pw@example.com/x", pub), /credentials/u);
    await assert.rejects(assertSafeWebhookUrl("https://localhost/x", pub), /internal/u);
    await assert.rejects(assertSafeWebhookUrl("https://169.254.169.254/latest", pub), /private/u);
    await assert.rejects(assertSafeWebhookUrl("https://sneaky.example.com/x", async () => ["10.0.0.9"]), /private/u);
    await assert.rejects(assertSafeWebhookUrl("https://nx.example.com/x", async () => []), /resolve/u);
    assert.equal((await assertSafeWebhookUrl("https://hooks.example.com/in", pub)).host, "hooks.example.com");
  });

  it("delivers a signed payload, retries on failure and records the outcome", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wh-"));
    const store = new Store(dir);
    store.putWebhook("t1", { webhook_id: "wh1", url: "https://hooks.example.com/in", events: ["monitor.triggered"], secret: "whsec_x", created_at: "", created_by: "root", active: true });
    store.putWebhook("t1", { webhook_id: "wh2", url: "https://other.example.com/in", events: ["analysis.failed"], secret: "whsec_y", created_at: "", created_by: "root", active: true });
    const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
    let n = 0;
    const post = async (url: string, init: any) => { seen.push({ url, headers: init.headers, body: init.body }); return { status: ++n < 3 ? 500 : 200 }; };
    const delivered = await dispatchWebhooks({ store, now: () => new Date("2026-10-17T03:00:00Z"), webhookPost: post as never, resolveHost: async () => ["93.184.216.34"] }, "t1", "monitor.triggered", { asset_id: "tok-aapl" });
    assert.equal(delivered, 1);
    assert.equal(seen.length, 3, "two failures then success");
    assert.ok(seen.every((s) => s.url.startsWith("https://hooks.example.com")), "only subscribed hooks are called");
    const h = seen[2]!.headers;
    assert.equal(h["x-sentinel-signature"], `sha256=${createHmac("sha256", "whsec_x").update(`${h["x-sentinel-timestamp"]}.${seen[2]!.body}`).digest("hex")}`);
    assert.equal(h["x-sentinel-signature"], signPayload("whsec_x", h["x-sentinel-timestamp"]!, seen[2]!.body));
    assert.equal(JSON.parse(seen[2]!.body).data.asset_id, "tok-aapl");
    assert.equal(store.getWebhook("t1", "wh1")!.last_delivery!.ok, true);
    assert.ok(store.readAudit("t1").some((e) => e.event === "webhook_delivery"));
    // DNS rebinding to a private address at send time is refused
    const rebound = await dispatchWebhooks({ store, now: () => new Date(), webhookPost: post as never, resolveHost: async () => ["127.0.0.1"] }, "t1", "monitor.triggered", {});
    assert.equal(rebound, 0);
    assert.match(store.getWebhook("t1", "wh1")!.last_delivery!.error!, /private/u);
    rmSync(dir, { recursive: true, force: true });
  });

  it("API: admin-only, https only, secret shown once, completed analyses fire the event", async () => {
    const calls: string[] = [];
    const srv = await boot({ apiKeys: KEYS, resolveHost: async () => ["93.184.216.34"], webhookPost: (async (url: string, init: any) => { calls.push(`${url}|${JSON.parse(init.body).event}`); return { status: 200 }; }) as never });
    try {
      assert.equal((await call("POST", `${srv.base}/webhooks`, "kAlice", { url: "https://hooks.example.com/in" })).status, 403);
      assert.equal((await call("POST", `${srv.base}/webhooks`, "kAdmin", { url: "http://hooks.example.com/in" })).status, 422);
      const bad = await call("POST", `${srv.base}/webhooks`, "kAdmin", { url: "https://hooks.example.com/in" });
      assert.equal(bad.status, 201);
      assert.match(bad.body.secret, /^whsec_/u);
      const list = await call("GET", `${srv.base}/webhooks`, "kAdmin");
      assert.equal(list.body.webhooks[0].secret, undefined, "secret is not listed again");
      await call("POST", `${srv.base}/assets`, "kAlice", { underlying: "AAPL" });
      const run = await call("POST", `${srv.base}/investment-assessment`, "kAlice", { asset_id: "tok-aapl", wait: true });
      assert.equal(run.status, 200);
      for (let i = 0; i < 40 && !calls.length; i++) await new Promise((r) => setTimeout(r, 25));
      assert.ok(calls.some((c) => c.endsWith("|analysis.completed")), calls.join());
      assert.equal((await call("DELETE", `${srv.base}/webhooks/${bad.body.webhook_id}`, "kAdmin")).status, 200);
    } finally { srv.close(); }
  });
});

describe("OIDC sign-in", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: "jwk" }) as object), kid: "k1", use: "sig", alg: "RS256" };
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const b64u = (o: unknown) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
  const sign = (claims: object, key = privateKey, header: object = { alg: "RS256", kid: "k1" }) => {
    const data = `${b64u(header)}.${b64u(claims)}`;
    return `${data}.${createSign("RSA-SHA256").update(data).sign(key).toString("base64url")}`;
  };
  const NOW = Date.UTC(2026, 9, 17, 3, 0, 0);
  const good = { iss: "https://idp.example.com", aud: "sentinel", sub: "u-123", exp: NOW / 1000 + 600, tenant: "acme", role: ["analyst"] };
  let jwksCalls = 0;
  const idpFetch = (async (url: string) => ({ ok: true, status: 200, json: async () => (url.includes("openid-configuration") ? { jwks_uri: "https://idp.example.com/jwks" } : (jwksCalls++, { keys: [jwk] })), text: async () => "" })) as never;
  const v = () => new OidcVerifier({ issuer: "https://idp.example.com", audience: "sentinel", tenantClaim: "tenant", roleClaim: "role", defaultTenant: null, clockSkewSec: 60 }, idpFetch, () => NOW);

  it("accepts a valid token and maps tenant/user/role; rejects every kind of bad token", async () => {
    assert.deepEqual(await v().verify(sign(good)), { tenant: "acme", role: "analyst", user: "u-123" });
    assert.equal((await v().verify(sign({ ...good, role: ["viewer", "admin"] }))).role, "admin");
    assert.equal((await v().verify(sign({ ...good, role: undefined }))).role, "viewer");
    await assert.rejects(v().verify(sign({ ...good, aud: "other" })), /audience/u);
    await assert.rejects(v().verify(sign({ ...good, iss: "https://evil.example.com" })), /issuer/u);
    await assert.rejects(v().verify(sign({ ...good, exp: NOW / 1000 - 3600 })), /expired/u);
    await assert.rejects(v().verify(sign({ ...good, nbf: NOW / 1000 + 3600 })), /not yet valid/u);
    await assert.rejects(v().verify(sign(good, other.privateKey)), /bad signature/u);
    await assert.rejects(v().verify(sign(good, privateKey, { alg: "HS256", kid: "k1" })), /RS256/u);
    await assert.rejects(v().verify(sign(good, privateKey, { alg: "RS256", kid: "nope" })), /key not found/u);
    await assert.rejects(v().verify(sign({ ...good, tenant: undefined })), /tenant/u);
  });

  it("API: a verified token is the identity; a forged one is 401; api keys still work", async () => {
    const srv = await boot({ oidc: v(), apiKeys: ["kAdmin;tenant=acme;role=admin;user=root"] });
    try {
      const me = await call("GET", `${srv.base}/me`, sign(good));
      assert.deepEqual([me.body.tenant, me.body.role, me.body.user], ["acme", "analyst", "u-123"]);
      assert.equal(me.headers.get("x-sentinel-auth"), "oidc");
      assert.equal((await call("GET", `${srv.base}/me`, sign(good, other.privateKey))).status, 401);
      assert.equal((await call("GET", `${srv.base}/me`)).status, 401);
      assert.equal((await call("GET", `${srv.base}/me`, "kAdmin")).body.user, "root");
      assert.equal((await call("POST", `${srv.base}/assets`, sign({ ...good, role: "viewer" }), { underlying: "AAPL" })).status, 403);
      assert.equal((await call("GET", `${srv.base}/auth/config`)).body.oidc.issuer, "https://idp.example.com", "login discovery is public");
    } finally { srv.close(); }
  });
});

describe("approval gate and analyst assignment", () => {
  it("viewers see only approved reports; assignment restricts who can review", async () => {
    const srv = await boot({ apiKeys: KEYS, requireApproval: true });
    try {
      await call("POST", `${srv.base}/assets`, "kAlice", { underlying: "AAPL" });
      const run = await call("POST", `${srv.base}/investment-assessment`, "kAlice", { asset_id: "tok-aapl", wait: true });
      const id = run.body.analysis_id;
      assert.equal((await call("GET", `${srv.base}/analyses/${id}/report`, "kView")).body.error.code, "approval_required");
      assert.equal((await call("GET", `${srv.base}/analyses/${id}`, "kView")).status, 403);
      assert.equal((await call("GET", `${srv.base}/analyses/${id}?summary=1`, "kView")).status, 200, "status summary stays visible");
      assert.equal((await call("GET", `${srv.base}/analyses`, "kView")).body.analyses.length, 0);
      assert.equal((await call("GET", `${srv.base}/analyses/${id}/report`, "kAlice")).status, 200, "analysts can read it to review");
      // assignment
      assert.equal((await call("POST", `${srv.base}/analyses/${id}/assign`, "kView", { assignee: "bob" })).status, 403);
      assert.equal((await call("POST", `${srv.base}/analyses/${id}/assign`, "kAlice", { assignee: "vic" })).status, 422, "viewers cannot be assignees");
      assert.equal((await call("POST", `${srv.base}/analyses/${id}/assign`, "kAlice", { assignee: "bob" })).body.assignee.user, "bob");
      assert.equal((await call("GET", `${srv.base}/analyses?assigned_to=me`, "kBob")).body.analyses.length, 1);
      assert.equal((await call("GET", `${srv.base}/analyses?assigned_to=me`, "kAlice")).body.analyses.length, 0);
      assert.equal((await call("POST", `${srv.base}/analyses/${id}/review`, "kAlice", { decision: "approved" })).status, 403, "not the assignee");
      const ok = await call("POST", `${srv.base}/analyses/${id}/review`, "kBob", { decision: "approved", notes: "checked" });
      assert.equal(ok.status, 200);
      assert.equal((await call("GET", `${srv.base}/analyses/${id}/report`, "kView")).status, 200, "visible after approval");
      assert.equal((await call("POST", `${srv.base}/analyses/${id}/assign`, "kAlice", { assignee: "bob" })).status, 409, "already reviewed");
    } finally { srv.close(); }
  });

  it("commerce holds the deliverable until approval; changes-requested and timeout fail with no deliverable", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ap-"));
    const store = new Store(dir);
    const env = { store, tenant: "public", now: () => new Date(), approvalPollMs: 5, approvalTimeoutMs: 400 } as never;
    const base = { analysis_id: "a1", asset_id: "x", dossier_version: "d", kind: "integrated_assessment", status: "completed", stage: null, requested_by: "t", created_at: "", completed_at: "", assessment_status: null, report_hash: null, calculation_hash: null, report_version: 1, previous_analysis_id: null, outdated: null, task: null, error: null, report: null };
    store.putAnalysis("public", base as never);
    setTimeout(() => store.updateAnalysis("public", "a1", { review: { status: "approved", reviewer: "bob", notes: "", at: "" } }), 40);
    await awaitApproval(env, "a1");
    store.updateAnalysis("public", "a1", { review: { status: "changes_requested", reviewer: "bob", notes: "recheck custody", at: "" } });
    await assert.rejects(awaitApproval(env, "a1"), /changes \(recheck custody\)/u);
    store.putAnalysis("public", { ...base, analysis_id: "a2" } as never);
    await assert.rejects(awaitApproval(env, "a2"), /No analyst approval/u);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("saved portfolios", () => {
  it("saves, lists, re-analyses and deletes; invalid holdings are refused", async () => {
    const srv = await boot({ apiKeys: KEYS });
    try {
      const h = [{ symbol: "AAPL", value_usd: 600 }, { symbol: "QQQ", value_usd: 400 }];
      assert.equal((await call("POST", `${srv.base}/portfolios`, "kView", { name: "Core", holdings: h })).status, 403);
      const a = await call("POST", `${srv.base}/portfolios`, "kAlice", { name: "Core", holdings: h });
      assert.equal(a.status, 201);
      assert.equal((await call("POST", `${srv.base}/portfolios`, "kAlice", { name: "core", holdings: h })).status, 200, "same name updates");
      assert.equal((await call("POST", `${srv.base}/portfolios`, "kAlice", { name: "Bad", holdings: [{ symbol: "DOGE", value_usd: 1 }] })).status, 422);
      assert.equal((await call("GET", `${srv.base}/portfolios`, "kView")).body.portfolios.length, 1);
      const an = await call("GET", `${srv.base}/portfolios/${a.body.portfolio_id}?analyze=1`, "kView");
      assert.equal(an.body.analysis.status, "ok");
      assert.equal(an.body.analysis.total_value_usd, 1000);
      assert.equal((await call("DELETE", `${srv.base}/portfolios/${a.body.portfolio_id}`, "kView")).status, 403);
      assert.equal((await call("DELETE", `${srv.base}/portfolios/${a.body.portfolio_id}`, "kAdmin")).status, 200);
      assert.equal((await call("GET", `${srv.base}/portfolios/${a.body.portfolio_id}`, "kAdmin")).status, 404);
    } finally { srv.close(); }
  });
});
