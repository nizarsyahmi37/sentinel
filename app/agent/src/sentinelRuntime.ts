/**
 * Wires the Sentinel product (src/sentinel/*) into the Studio seller runtime.
 *
 * Boundaries kept from the Studio template:
 *  - signing stays in signing.ts; nothing here can sign, move funds or change
 *    the payee or price. `recordSubmit` only OBSERVES the result of a submit.
 *  - the language model only narrates (see sentinel/thesis.ts) and never
 *    receives raw document text.
 */
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateText } from "ai";
import express from "express";
import { SellerAgentExecutor } from "./executor.js";
import { buildModel } from "./model.js";
import * as defaultSigning from "./signing.js";
import type { SigningApi } from "./sellerCore.js";
import { OidcVerifier, oidcConfigFromEnv } from "./sentinel/oidc.js";
import { type CommerceEnv, TaskError, precheckTask, recordSubmit, createSentinelWork } from "./sentinel/commerce.js";
import { createApi, startMonitorScheduler, type ServiceInfo } from "./sentinel/service.js";
import { Store } from "./sentinel/store.js";
import { createHirer, hireConfigFromEnv } from "./sentinel/hire.js";
import { defaultFetch } from "./sentinel/sources.js";
import type { Narrate } from "./sentinel/thesis.js";
import { UI_HTML } from "./sentinel/ui.js";

type Table = Record<string, unknown>;
const tbl = (v: unknown): Table => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Table) : {});

export interface SentinelRuntime {
  env: CommerceEnv;
  work: ReturnType<typeof createSentinelWork>;
  signing: SigningApi;
  routes: express.Router;
  Executor: typeof SellerAgentExecutor;
}

function llmNarrate(store: Store, modelName: string): Narrate {
  let model: ReturnType<typeof buildModel> | undefined;
  return async ({ system, prompt }) => {
    model ??= buildModel();
    const res = await generateText({ model, system, prompt, abortSignal: AbortSignal.timeout(45_000) });
    try {
      store.appendLedger({
        at: new Date().toISOString(), kind: "llm_call", model: modelName,
        input_tokens: res.usage?.inputTokens ?? null, output_tokens: res.usage?.outputTokens ?? null,
        cost_usd: /free/iu.test(modelName) ? 0 : null,
      });
    } catch {
      /* ledger is best-effort */
    }
    return res.text;
  };
}

/** Managed runtimes mount the code read-only (EACCES on mkdir); fall back to the temp dir (not durable). */
export function defaultDataDir(cwd = process.cwd(), tmp = tmpdir()): string {
  const preferred = path.resolve(cwd, ".sentinel-data");
  try {
    mkdirSync(preferred, { recursive: true });
    return preferred;
  } catch {
    return path.join(tmp, "sentinel-data");
  }
}

const firstDefined = (...v: unknown[]): string | null => {
  const x = v.find((y) => y !== undefined && y !== null && y !== "");
  return x === undefined ? null : String(x);
};

export function buildSentinelRuntime(args: { cfg: Table; walletAddress: string; network: string }): SentinelRuntime {
  const dataDir = process.env.SENTINEL_DATA_DIR ?? defaultDataDir();
  const store = new Store(dataDir);
  const tenant = process.env.SENTINEL_COMMERCE_TENANT ?? "public";
  const env: CommerceEnv = {
    store,
    tenant,
    narrate: process.env.SENTINEL_NARRATIVE === "off" ? undefined : llmNarrate(store, String(tbl(args.cfg.llm).model ?? "unknown")),
    now: () => new Date(),
    offline: process.env.SENTINEL_OFFLINE === "1",
    cacheDir: path.join(dataDir, "_cache"),
    requireApproval: process.env.SENTINEL_REQUIRE_APPROVAL === "1",
    approvalTimeoutMs: Number(process.env.SENTINEL_APPROVAL_TIMEOUT_MIN ?? 30) * 60_000,
  };
  const work = createSentinelWork(env);

  // Observe (never alter) the real on-chain submission so the UI can show real refs.
  const signing: SigningApi = {
    listPrice: defaultSigning.listPrice,
    clampPrice: defaultSigning.clampPrice,
    signQuote: defaultSigning.signQuote,
    verifySignedJob: defaultSigning.verifySignedJob,
    jobSpec: defaultSigning.jobSpec,
    submitResult: async (jobId, content, metadata) => {
      const res = await defaultSigning.submitResult(jobId, content, metadata);
      try {
        recordSubmit(env, jobId, res);
        store.appendLedger({ at: new Date().toISOString(), kind: "report_submitted", job_id: String(jobId), price_usd: String(tbl(tbl(args.cfg.payments).seller).price_usd ?? "") });
      } catch (e) {
        console.error("[sentinel] could not record submit ref", e instanceof Error ? e.message : e);
      }
      return res;
    },
  };

  const payments = tbl(args.cfg.payments);
  const seller = tbl(payments.seller);
  const stack = tbl(args.cfg.stack);
  const erc8004 = tbl(args.cfg.erc8004);
  const identity = tbl(args.cfg.identity); // written by `bag deploy verify` after ERC-8004 registration
  const serviceInfo = (): ServiceInfo => ({
    price_usd: String(seller.price_usd ?? "0.10"),
    assets: Array.isArray(seller.assets) ? (seller.assets as string[]) : [],
    network: args.network,
    agent_address: args.walletAddress,
    agent_id: process.env.SENTINEL_AGENT_ID ?? firstDefined(identity.agent_id, erc8004.agent_id),
    agent_url: process.env.BNBAGENT_PUBLIC_URL ?? process.env.AGENTCORE_RUNTIME_URL ?? (typeof identity.endpoint === "string" ? identity.endpoint : null),
    identity_tx: process.env.SENTINEL_IDENTITY_TX ?? null,
    protocols: Array.isArray(stack.protocols) ? (stack.protocols as string[]) : [],
    rails: [tbl(payments.erc8183).enabled !== false ? "erc8183" : "", tbl(payments.b402_seller).enabled !== false ? "b402" : ""].filter(Boolean),
  });

  const keys = (process.env.SENTINEL_API_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  // Secure default: a deployed runtime without API keys does not expose the open
  // "public" tenant. Set SENTINEL_API_KEYS (or SENTINEL_ALLOW_OPEN_API=1 to opt out).
  const deployed = Boolean(process.env.AGENTCORE_RUNTIME_URL || process.env.BNBAGENT_PUBLIC_URL);
  const requireAuth = process.env.SENTINEL_REQUIRE_AUTH === "1" || (deployed && keys.length === 0 && process.env.SENTINEL_ALLOW_OPEN_API !== "1");
  const oidcCfg = oidcConfigFromEnv();
  const monitorMinutes = Number(process.env.SENTINEL_MONITOR_INTERVAL_MINUTES ?? 0);
  if (monitorMinutes > 0) startMonitorScheduler(env, monitorMinutes, process.env.SENTINEL_MONITOR_AUTO_REASSESS === "1");
  const hireCfg = hireConfigFromEnv(process.env, serviceInfo());
  const routes = express.Router();
  routes.use(
    "/api/v1",
    createApi({
      ...env,
      serviceInfo,
      hirer: hireCfg ? createHirer(hireCfg, { fetch: defaultFetch }) : null,
      apiKeys: keys,
      requireAuth: requireAuth && !oidcCfg,
      oidc: oidcCfg ? new OidcVerifier(oidcCfg) : null,
      requireApproval: process.env.SENTINEL_REQUIRE_APPROVAL === "1",
      rateLimitPerMinute: Number(process.env.SENTINEL_RATE_LIMIT_PER_MIN ?? 120),
    }),
  );
  routes.get(["/app", "/app/"], (req, res) => {
    if (req.path === "/app") return res.redirect(301, "/app/");
    res.setHeader("content-security-policy", "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
    res.setHeader("x-content-type-options", "nosniff");
    res.type("html").send(UI_HTML);
  });
  routes.get("/", (req, res, next) => (req.accepts(["html", "json"]) === "html" ? res.redirect(302, "/app/") : next()));

  class SentinelExecutor extends SellerAgentExecutor {
    /** Refuse to quote a task Sentinel cannot deliver — before the buyer funds anything. */
    override async negotiate(data: Record<string, unknown>): Promise<Record<string, unknown>> {
      const req = tbl(data.request);
      const task = (typeof req.task_description === "string" ? req.task_description : undefined) ?? (typeof data.task_description === "string" ? data.task_description : undefined);
      try {
        precheckTask(task, store, tenant);
      } catch (e) {
        if (e instanceof TaskError) {
          // A readable refusal (the runtime would otherwise mask a thrown error).
          return { status: "rejected", accepted: false, reason: `Sentinel cannot quote this task: ${e.message}`, service_catalog: "/api/v1/services" };
        }
        throw e;
      }
      return super.negotiate(data);
    }
  }
  return { env, work, signing, routes, Executor: SentinelExecutor };
}
