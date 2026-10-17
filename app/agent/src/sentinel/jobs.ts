/**
 * Read-only view of an ERC-8183 job straight from the chain (eth_call getJob).
 * No wallet, keystore or signing is involved: this only shows what a buyer already did on-chain.
 *
 * The commerce contract address is the `verifying_contract` bound into Sentinel's signed quotes on
 * BSC testnet; it is a public address. Override with SENTINEL_COMMERCE_ADDRESS for another stack.
 */
import { createHash } from "node:crypto";
import { CHAINS } from "./chains.js";
import { decodeAddress, decodeUint, makeRpc } from "./chain.js";
import type { FetchLike } from "./sources.js";

const COMMERCE: Record<string, string> = { "bsc-testnet": "0xa206c0517B6371C6638CD9e4a42Cc9f02A33B0DE" };
const GET_JOB = "0xbf22c457"; // getJob(uint256)
const JOB_FUNDED = "0xbdb056de345bfeadca7c9fd7df6430bdb83c677c8eefbb601dff56f34d3dac52"; // JobFunded(uint256 indexed jobId, address indexed client, address indexed provider, uint256 amount)
// The policy contract records where a submitted deliverable lives: JobInitialised(uint256 indexed jobId, bytes32 deliverable, uint64 submittedAt, bytes optParams) with optParams = JSON {deliverable_url}.
const POLICY: Record<string, string> = { "bsc-testnet": "0xd6a4217588f6b1f5657a92a3e94e6422ad771cea" };
const JOB_INITIALISED = "0x979e9cbf6f2afb4a66fd728cf2159d5f9119c4df4c65d24187fce959c64d3a8d";
const DELIVERABLE_HOSTS = new Set(["bnbagent-api.bnbchain.world"]);
const STATUS = ["OPEN", "FUNDED", "SUBMITTED", "COMPLETED", "REJECTED", "EXPIRED"] as const;

export interface OnChainJob {
  job_id: number;
  network: string;
  contract: string;
  status: (typeof STATUS)[number] | "UNKNOWN";
  client: string;
  provider: string;
  evaluator: string;
  /** The task text the buyer put on the job (for Sentinel: e.g. "equity:NVDA"). Buyer-supplied, untrusted. */
  task: string;
  budget_atomic: string;
  budget_u: string;
  expires_at: string | null;
  submitted_at: string | null;
  deliverable_hash: string | null;
  paid_to_provider: boolean;
  explorer: { contract: string; client: string; provider: string };
  source: string;
}

const readString = (h: string, tupleWord: number, offsetWord: number): string => {
  const off = Number(BigInt("0x" + h.slice(offsetWord * 64, (offsetWord + 1) * 64)) / 32n);
  const lenWord = tupleWord + off;
  const len = Number(BigInt("0x" + (h.slice(lenWord * 64, (lenWord + 1) * 64) || "0")));
  if (!Number.isSafeInteger(len) || len > 4096) return "";
  return Buffer.from(h.slice((lenWord + 1) * 64, (lenWord + 1) * 64 + len * 2), "hex").toString("utf8");
};
/** The on-chain description is the buyer's signed quote JSON (or plain text); pull out the task text. */
export function taskText(description: string): string {
  const t = description.trim();
  if (!t.startsWith("{")) return t.slice(0, 200);
  try {
    const q = JSON.parse(t) as { task?: unknown; task_description?: unknown; request?: { task_description?: unknown } };
    const v = [q.task, q.task_description, q.request?.task_description].find((x) => typeof x === "string");
    return typeof v === "string" ? v.slice(0, 200) : "";
  } catch {
    return t.slice(0, 200);
  }
}
const addr = (word: string): string => decodeAddress("0x" + word) ?? "";
const iso = (secs: bigint): string | null => (secs > 0n ? new Date(Number(secs) * 1000).toISOString() : null);

/** Returns null when the job does not exist on that network. Throws SourceError when no RPC answers. */
export async function readJob(f: FetchLike, network: string, jobId: number): Promise<OnChainJob | null> {
  const contract = process.env.SENTINEL_COMMERCE_ADDRESS ?? COMMERCE[network];
  if (!contract) throw new Error(`No ERC-8183 commerce contract is configured for ${network}.`);
  const { rpc, host } = makeRpc(f, network);
  const data = GET_JOB + jobId.toString(16).padStart(64, "0");
  const raw = String(await rpc("eth_call", [{ to: contract, data }, "latest"]));
  if (raw.length < 2 + 64 * 12) return null; // reverted / not a job
  const h = raw.slice(2);
  const w = (i: number): string => h.slice(i * 64, (i + 1) * 64); // word 0 is the tuple offset
  const id = decodeUint("0x" + w(1)) ?? 0n;
  if (id !== BigInt(jobId)) return null;
  const st = Number(decodeUint("0x" + w(8)) ?? 99n);
  const budget = decodeUint("0x" + w(6)) ?? 0n;
  const deliverable = w(11);
  const base = CHAINS[network]?.explorer ?? "https://testnet.bscscan.com";
  const client = addr(w(2));
  const provider = addr(w(3));
  const status = STATUS[st] ?? "UNKNOWN";
  return {
    job_id: jobId,
    network,
    contract,
    status,
    client,
    provider,
    evaluator: addr(w(4)),
    task: taskText(readString(h, 1, 5)),
    budget_atomic: budget.toString(),
    budget_u: (Number(budget) / 1e18).toString(),
    expires_at: iso(decodeUint("0x" + w(7)) ?? 0n),
    submitted_at: iso(decodeUint("0x" + w(10)) ?? 0n),
    deliverable_hash: /^0+$/u.test(deliverable) ? null : "0x" + deliverable,
    paid_to_provider: status === "COMPLETED",
    explorer: { contract: `${base}/address/${contract}`, client: `${base}/address/${client}`, provider: `${base}/address/${provider}` },
    source: `${host()} eth_call getJob`,
  };
}

export interface JobSummary {
  job_id: number;
  status: OnChainJob["status"];
  budget_u: string;
  client: string;
  submitted_at: string | null;
  paid_to_provider: boolean;
  funded_block: number;
  task: string;
  deliverable_url: string | null;
}

/**
 * Recent jobs funded for one provider, newest first: JobFunded events for that provider (a few block windows,
 * because public RPCs cap eth_getLogs ranges), then each job's current state. Needs an RPC that serves getLogs
 * (the second default testnet endpoint does).
 */
export async function listProviderJobs(f: FetchLike, network: string, provider: string, opts: { limit?: number; windows?: number; windowBlocks?: number } = {}): Promise<JobSummary[]> {
  const contract = process.env.SENTINEL_COMMERCE_ADDRESS ?? COMMERCE[network];
  if (!contract) throw new Error(`No ERC-8183 commerce contract is configured for ${network}.`);
  const { rpc } = makeRpc(f, network, 12000);
  const windows = opts.windows ?? 3;
  const size = opts.windowBlocks ?? 40000;
  const head = Number(BigInt(String(await rpc("eth_blockNumber", []))));
  const topicProvider = "0x" + provider.toLowerCase().replace(/^0x/u, "").padStart(64, "0");
  const found = new Map<number, number>();
  for (let w = 0; w < windows; w++) {
    const to = head - w * size;
    const from = Math.max(0, to - size + 1);
    const logs = (await rpc("eth_getLogs", [{ address: contract, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), topics: [JOB_FUNDED, null, null, topicProvider] }])) as { topics: string[]; blockNumber: string }[];
    for (const l of logs) found.set(Number(BigInt(l.topics[1]!)), Number(BigInt(l.blockNumber)));
    if (found.size >= (opts.limit ?? 10)) break;
  }
  const ids = [...found.keys()].sort((a, b) => b - a).slice(0, opts.limit ?? 10);
  const jobs = await Promise.all(ids.map((id) => readJob(f, network, id).catch(() => null)));
  const submitted = jobs.flatMap((j) => (j && j.submitted_at ? [j.job_id] : []));
  const urls = await deliverableUrls(f, network, submitted).catch(() => new Map<number, string>());
  return jobs.flatMap((j) => (j ? [{ job_id: j.job_id, status: j.status, budget_u: j.budget_u, client: j.client, submitted_at: j.submitted_at, paid_to_provider: j.paid_to_provider, funded_block: found.get(j.job_id)!, task: j.task, deliverable_url: urls.get(j.job_id) ?? null }] : []));
}

const topicOf = (id: number): string => "0x" + id.toString(16).padStart(64, "0");
const hexToUtf8 = (hex: string): string => Buffer.from(hex.replace(/^0x/u, ""), "hex").toString("utf8");

/** Deliverable URLs for submitted jobs, from the policy contract's JobInitialised events. Missing entries mean "not found in the searched window". */
export async function deliverableUrls(f: FetchLike, network: string, ids: number[], opts: { windows?: number; windowBlocks?: number } = {}): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const policy = process.env.SENTINEL_POLICY_ADDRESS ?? POLICY[network];
  if (!policy || ids.length === 0) return out;
  const { rpc } = makeRpc(f, network, 12000);
  const head = Number(BigInt(String(await rpc("eth_blockNumber", []))));
  const size = opts.windowBlocks ?? 40000;
  for (let w = 0; w < (opts.windows ?? 3) && out.size < ids.length; w++) {
    const to = head - w * size;
    const from = Math.max(0, to - size + 1);
    const logs = (await rpc("eth_getLogs", [{ address: policy, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), topics: [JOB_INITIALISED, ids.map(topicOf)] }])) as { topics: string[]; data: string }[];
    for (const l of logs) {
      try {
        const id = Number(BigInt(l.topics[1]!));
        const d = l.data.slice(2);
        const off = Number(BigInt("0x" + d.slice(128, 192)) / 32n);
        const len = Number(BigInt("0x" + d.slice(off * 64, (off + 1) * 64)));
        const params = JSON.parse(hexToUtf8(d.slice((off + 1) * 64, (off + 1) * 64 + len * 2))) as { deliverable_url?: unknown };
        if (typeof params.deliverable_url === "string" && /^https:\/\//u.test(params.deliverable_url)) out.set(id, params.deliverable_url);
      } catch {
        /* ignore a malformed event */
      }
    }
  }
  return out;
}

export interface DeliverableSummary {
  url: string;
  sha256: string;
  sha256_matches_url: boolean | null;
  assessment_status: string | null;
  headline: string | null;
  report_hash: string | null;
  analysis_id: string | null;
  generated_at: string | null;
  size_bytes: number;
}

/** Fetches a deliverable from the platform's managed storage (fixed host allow-list, https only, size-capped) and summarises it. */
export async function summarizeDeliverable(f: FetchLike, url: string): Promise<DeliverableSummary> {
  const u = new URL(url);
  if (u.protocol !== "https:" || !DELIVERABLE_HOSTS.has(u.host)) throw new Error(`Deliverables are only read from ${[...DELIVERABLE_HOSTS].join(", ")}.`);
  const res = await f(u.toString(), { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Deliverable download answered HTTP ${res.status}.`);
  const text = await res.text();
  if (text.length > 8_000_000) throw new Error("Deliverable is larger than 8 MB; not reading it.");
  const sha = createHash("sha256").update(text).digest("hex");
  const pathHash = /\/sha256\/([0-9a-f]{64})\.json$/u.exec(u.pathname)?.[1];
  let status: string | null = null;
  let headline: string | null = null;
  let reportHash: string | null = null;
  let analysisId: string | null = null;
  let generated: string | null = null;
  try {
    const raw = JSON.parse(text) as { response?: { content?: unknown } };
    const payload = (typeof raw.response?.content === "string" ? JSON.parse(raw.response.content) : raw) as { report?: { executive_summary?: { headline?: string }; generated_at?: string; hashes?: { report_hash?: string } }; sentinel?: { assessment_status?: string; report_hash?: string; analysis_id?: string } };
    status = payload.sentinel?.assessment_status ?? null;
    headline = payload.report?.executive_summary?.headline?.slice(0, 400) ?? null;
    reportHash = payload.sentinel?.report_hash ?? payload.report?.hashes?.report_hash ?? null;
    analysisId = payload.sentinel?.analysis_id ?? null;
    generated = payload.report?.generated_at ?? null;
  } catch {
    /* not a Sentinel report: leave the summary fields empty */
  }
  return { url, sha256: sha, sha256_matches_url: pathHash ? pathHash === sha : null, assessment_status: status, headline, report_hash: reportHash, analysis_id: analysisId, generated_at: generated, size_bytes: text.length };
}
