import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { SentinelClient, SentinelError, verifyWebhook } from "../../../sdk/sentinel-client.ts";
import { OPERATIONS, buildOpenApi } from "../src/sentinel/openapi.js";
import { createApi, type ServiceInfo } from "../src/sentinel/service.js";
import { Store } from "../src/sentinel/store.js";
import { fakeMarket, makeFetch, newNet } from "./helpers.js";

const info: ServiceInfo = { price_usd: "0.10", assets: ["TEST_U"], network: "bsc-testnet", agent_address: null, agent_id: null, agent_url: null, identity_tx: null, protocols: [], rails: [] };
async function boot(apiKeys: string[] = []) {
  const dir = mkdtempSync(path.join(tmpdir(), "sdk-"));
  const router = createApi({ store: new Store(dir), now: () => new Date(), fetchImpl: makeFetch(newNet({ market: fakeMarket({ AAPL: 1, NVDA: 1.5, SPY: 1, QQQ: 1.1 }) })), skipPeers: true, serviceInfo: () => info, apiKeys });
  const app = express();
  app.use("/api/v1", router);
  return new Promise<{ base: string; router: any; close: () => void }>((resolve) => {
    const server = app.listen(0, () => resolve({ base: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`, router, close: () => { server.close(); rmSync(dir, { recursive: true, force: true }); } }));
  });
}

describe("OpenAPI", () => {
  it("documents every route the router serves (drift guard) and nothing that does not exist", async () => {
    const srv = await boot();
    try {
      const norm = (p: string) => p.replace(/:[A-Za-z]+/gu, "{x}").replace(/\{[^}]+\}/gu, "{x}");
      const served = new Set<string>();
      for (const l of srv.router.stack) if (l.route) for (const m of Object.keys(l.route.methods)) served.add(`${m} ${norm(l.route.path)}`);
      const documented = new Set(OPERATIONS.map(([m, p]) => `${m} ${norm(p)}`));
      const missing = [...served].filter((x) => !documented.has(x));
      const phantom = [...documented].filter((x) => !served.has(x));
      assert.deepEqual(missing, [], `routes missing from the OpenAPI document: ${missing.join(", ")}`);
      assert.deepEqual(phantom, [], `documented but not served: ${phantom.join(", ")}`);
      const spec = buildOpenApi() as any;
      assert.equal(spec.openapi, "3.1.0");
      assert.equal(spec.paths["/webhooks"].post["x-required-role"], "admin");
      assert.equal(spec.paths["/health"].get.security.length, 0);
      const live = await fetch(`${srv.base}/openapi.json`).then((r) => r.json());
      assert.equal(live.info.title, "Sentinel API");
    } finally { srv.close(); }
  });
});

describe("SDK", () => {
  it("drives the real API end to end with typed errors", async () => {
    const srv = await boot(["kAdmin;tenant=acme;role=admin;user=root", "kView;tenant=acme;role=viewer;user=vic"]);
    try {
      const admin = new SentinelClient({ baseUrl: srv.base, apiKey: "kAdmin" });
      const viewer = new SentinelClient({ baseUrl: srv.base, apiKey: "kView" });
      assert.equal((await admin.me()).role, "admin");
      await admin.saveAsset({ underlying: "AAPL" });
      const run = await admin.assess("tok-aapl");
      assert.ok(run.report.hashes.calculation_hash);
      assert.equal((await admin.reproduce(run.analysis_id)).reproduced, true);
      assert.match(await admin.report(run.analysis_id, "csv"), /^section,id,label/u);
      assert.match(await admin.report(run.analysis_id, "html"), /Sentinel report/u);
      assert.equal((await admin.listAnalyses()).analyses.length, 1);
      const pf = await admin.savePortfolio("Core", [{ symbol: "AAPL", value_usd: 100 }, { symbol: "QQQ", value_usd: 100 }]);
      assert.equal((await admin.getPortfolio(pf.portfolio_id, true)).analysis.status, "ok");
      assert.ok((await admin.tokenRegistry({ underlying: "NVDA" })).tokens.length >= 2);
      assert.ok((await admin.metrics()).usage.reports_delivered >= 1);
      assert.ok((await admin.openapi()).paths["/assets"]);
      await assert.rejects(viewer.saveAsset({ underlying: "AAPL" }), (e: unknown) => e instanceof SentinelError && e.status === 403 && e.code === "forbidden");
      await assert.rejects(admin.saveAsset({ underlying: "DOGE" }), (e: unknown) => e instanceof SentinelError && e.status === 422 && Array.isArray(e.issues));
      await assert.rejects(new SentinelClient({ baseUrl: srv.base, apiKey: "bad" }).me(), (e: unknown) => e instanceof SentinelError && e.status === 401);
      const started = await admin.start("tok-aapl");
      const done = await admin.waitFor(started.analysis_id, { intervalMs: 20 });
      assert.ok(done.result || done.status === "completed");
    } finally { srv.close(); }
  });

  it("verifyWebhook accepts a genuine delivery and rejects tampering, wrong secrets and replays", () => {
    const secret = "whsec_test";
    const ts = "2026-10-17T03:00:00.000Z";
    const body = JSON.stringify({ event: "analysis.completed" });
    const sig = `sha256=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;
    const now = Date.parse(ts) + 10_000;
    const h = { "x-sentinel-timestamp": ts, "x-sentinel-signature": sig };
    assert.equal(verifyWebhook(secret, h, body, 300, now), true);
    assert.equal(verifyWebhook(secret, h, body + " ", 300, now), false, "tampered body");
    assert.equal(verifyWebhook("whsec_other", h, body, 300, now), false, "wrong secret");
    assert.equal(verifyWebhook(secret, h, body, 300, now + 3_600_000), false, "replay outside tolerance");
    assert.equal(verifyWebhook(secret, {}, body, 300, now), false, "missing headers");
  });
});
