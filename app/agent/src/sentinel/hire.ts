/**
 * Local-only "hire Sentinel" helper for the demo UI: acts as a BUYER agent.
 *
 * It never signs anything itself and never reads a key. Signing is done by the `bag` CLI inside a separate
 * BUYER project (its own wallet and keystore, outside this repo). This module only orchestrates:
 *   1. OAuth token for the deployed agent   2. A2A `negotiate` (signed quote)
 *   3. `bag erc8183 buy --quote-json`       4. A2A `notify_funded`
 *
 * Guards (all enforced in code, see test/hire.test.ts): off unless SENTINEL_HIRE_BUYER_DIR is set; loopback callers only;
 * the provider is fixed to this agent's own wallet; a quote above the service price is refused BEFORE any funding;
 * one hire at a time; a hard cap on hires per process; the child process gets a minimal environment (no seller secrets).
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FetchLike } from "./sources.js";

export interface HireConfig {
  buyerDir: string;
  platform: string;
  agentId: string;
  clientId: string;
  clientSecret: string;
  provider: string;
  priceUsd: string;
  network: string;
  currency: string;
  maxHires: number;
  bagBin: string;
}

export type HireExec = (bin: string, args: string[], opts: { cwd: string; env: Record<string, string>; timeoutMs: number }) => Promise<{ stdout: string }>;

export interface HireStep {
  name: string;
  status: "pending" | "running" | "done" | "failed";
  detail?: string;
}
export interface HireRun {
  hire_id: string;
  task: string;
  status: "running" | "submitted" | "failed";
  steps: HireStep[];
  job_id: number | null;
  error: string | null;
  started_at: string;
}

const STEPS = ["Get access token", "Negotiate a signed quote", "Fund the job on-chain (4 transactions)", "Notify Sentinel (notify_funded)"];
const TASK = /^equity:[A-Za-z]{1,5}$/u;
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export const isLoopback = (addr: string | undefined): boolean => !!addr && LOOPBACK.has(addr);

export function hireConfigFromEnv(env: NodeJS.ProcessEnv, svc: { agent_address: string | null; price_usd: string; network: string }): HireConfig | null {
  const buyerDir = env.SENTINEL_HIRE_BUYER_DIR;
  if (!buyerDir || !svc.agent_address || !env.SENTINEL_CLIENT_ID || !env.SENTINEL_CLIENT_SECRET) return null;
  return {
    buyerDir: path.resolve(buyerDir),
    platform: env.SENTINEL_HIRE_PLATFORM ?? "https://bnbagent-api.bnbchain.world",
    agentId: env.SENTINEL_HIRE_AGENT_ID ?? "01M53XVV1VPE9MS604Y48VB4PM",
    clientId: env.SENTINEL_CLIENT_ID,
    clientSecret: env.SENTINEL_CLIENT_SECRET,
    provider: svc.agent_address,
    priceUsd: svc.price_usd,
    network: svc.network,
    currency: env.SENTINEL_HIRE_CURRENCY ?? "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565",
    maxHires: Math.max(1, Number(env.SENTINEL_HIRE_MAX ?? 3)),
    bagBin: env.SENTINEL_HIRE_BAG ?? "bag",
  };
}

export const defaultExec: HireExec = (bin, args, o) =>
  new Promise((resolve, reject) => {
    const child = execFile(bin, args, { cwd: o.cwd, env: o.env, timeout: o.timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).split("\n").filter((l) => !l.startsWith("AUDIT") && l.trim()).slice(-3).join(" ").slice(0, 400)));
      else resolve({ stdout });
    });
    child.stdin?.end(); // never leave the CLI waiting on input
  });

const toAtomic = (usd: string): bigint => {
  const [i = "0", f = ""] = usd.split(".");
  return BigInt(i) * 10n ** 18n + BigInt((f + "0".repeat(18)).slice(0, 18));
};

export type Hirer = ReturnType<typeof createHirer>;

export function createHirer(cfg: HireConfig, deps: { fetch: FetchLike; exec?: HireExec; now?: () => Date }) {
  const exec = deps.exec ?? defaultExec;
  const now = deps.now ?? (() => new Date());
  const runs = new Map<string, HireRun>();
  let active = false;
  let started = 0;

  const rpc = async (token: string, data: Record<string, unknown>, rid: string): Promise<{ result?: { parts?: { data?: Record<string, unknown> }[] }; error?: { message?: string } }> => {
    const res = await deps.fetch(`${cfg.platform}/v1/rt/${cfg.agentId}/a2a`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: rid, method: "message/send", params: { message: { messageId: `msg-${rid}`, role: "user", parts: [{ kind: "data", data }] } } }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`Sentinel A2A endpoint answered HTTP ${res.status}`);
    return (await res.json()) as never;
  };

  async function execute(run: HireRun): Promise<void> {
    const step = (i: number, status: HireStep["status"], detail?: string): void => {
      run.steps[i] = { name: STEPS[i]!, status, ...(detail ? { detail } : {}) };
    };
    let i = 0;
    let dir: string | null = null;
    try {
      step(0, "running");
      const tok = await deps.fetch(`${cfg.platform}/v1/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: cfg.clientId, client_secret: cfg.clientSecret, scope: `invoke:${cfg.agentId}` }).toString(),
      });
      const tj = (await tok.json().catch(() => ({}))) as { access_token?: string };
      if (!tok.ok || !tj.access_token) throw new Error(`Could not get an access token (HTTP ${tok.status}).`);
      step(0, "done");

      i = 1;
      step(1, "running");
      const nego = await rpc(tj.access_token, { skill: "negotiate", task_description: run.task, terms: { deliverables: "Sentinel report", quality_standards: "evidence-backed, reproducible", currency: cfg.currency } }, `n-${run.hire_id}`);
      const env = nego.result?.parts?.[0]?.data as { response?: { accepted?: boolean; terms?: { price?: string; currency?: string } } } | undefined;
      if (!env || env.response?.accepted !== true) throw new Error(nego.error?.message ?? "Sentinel did not accept the task (no signed quote).");
      const price = BigInt(env.response.terms?.price ?? "0");
      if (price <= 0n || price > toAtomic(cfg.priceUsd)) throw new Error(`Quoted price ${price} is not within the service price of $${cfg.priceUsd}; refusing to fund.`);
      if ((env.response.terms?.currency ?? "").toLowerCase() !== cfg.currency.toLowerCase()) throw new Error("Quote currency is not the expected testnet U token; refusing to fund.");
      step(1, "done", `${Number(price) / 1e18} U`);

      i = 2;
      step(2, "running");
      dir = mkdtempSync(path.join(tmpdir(), "sentinel-hire-"));
      const quote = path.join(dir, "quote.json");
      writeFileSync(quote, JSON.stringify(env), { mode: 0o600 });
      const out = await exec(cfg.bagBin, ["erc8183", "buy", "--provider", cfg.provider, "--task", run.task, "--quote-json", quote, "--budget-usd", cfg.priceUsd, "--deadline-min", "30", "--network", cfg.network], {
        cwd: cfg.buyerDir,
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
        timeoutMs: 240_000,
      });
      const m = /^job_id:\s*(\d+)/mu.exec(out.stdout);
      if (!m) throw new Error("The buyer CLI finished without reporting a job id.");
      run.job_id = Number(m[1]);
      step(2, "done", `job #${run.job_id}`);

      i = 3;
      step(3, "running");
      const ack = await rpc(tj.access_token, { skill: "notify_funded", job_id: run.job_id }, `f-${run.hire_id}`);
      const a = ack.result?.parts?.[0]?.data as { status?: string } | undefined;
      if (a?.status !== "accepted") throw new Error(ack.error?.message ?? "Sentinel did not accept the funded job.");
      step(3, "done", "accepted; delivery runs in the background");
      run.status = "submitted";
    } catch (e) {
      step(i, "failed", e instanceof Error ? e.message : String(e));
      run.status = "failed";
      run.error = e instanceof Error ? e.message : String(e);
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
      active = false;
    }
  }

  return {
    /** Starts a hire; throws a coded error the API maps to an HTTP status. */
    start(task: string): HireRun {
      if (!TASK.test(task)) throw Object.assign(new Error('Task must look like "equity:NVDA".'), { code: 422 });
      if (active) throw Object.assign(new Error("A hire is already running."), { code: 409 });
      if (started >= cfg.maxHires) throw Object.assign(new Error(`Hire limit reached (${cfg.maxHires} per server run). Restart the server to allow more.`), { code: 429 });
      active = true;
      started += 1;
      const hire_id = `hire_${started}_${now().getTime().toString(36)}`;
      const run: HireRun = { hire_id, task: `equity:${task.slice(7).toUpperCase()}`, status: "running", steps: STEPS.map((name) => ({ name, status: "pending" as const })), job_id: null, error: null, started_at: now().toISOString() };
      runs.set(hire_id, run);
      void execute(run);
      return run;
    },
    get: (id: string): HireRun | undefined => runs.get(id),
    info: () => ({ enabled: true, max_hires: cfg.maxHires, hires_started: started, price_usd: cfg.priceUsd, provider: cfg.provider, network: cfg.network }),
  };
}
