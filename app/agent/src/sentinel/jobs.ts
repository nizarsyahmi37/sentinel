/**
 * Read-only view of an ERC-8183 job straight from the chain (eth_call getJob).
 * No wallet, keystore or signing is involved: this only shows what a buyer already did on-chain.
 *
 * The commerce contract address is the `verifying_contract` bound into Sentinel's signed quotes on
 * BSC testnet; it is a public address. Override with SENTINEL_COMMERCE_ADDRESS for another stack.
 */
import { CHAINS } from "./chains.js";
import { decodeAddress, decodeUint, makeRpc } from "./chain.js";
import type { FetchLike } from "./sources.js";

const COMMERCE: Record<string, string> = { "bsc-testnet": "0xa206c0517B6371C6638CD9e4a42Cc9f02A33B0DE" };
const GET_JOB = "0xbf22c457"; // getJob(uint256)
const JOB_FUNDED = "0xbdb056de345bfeadca7c9fd7df6430bdb83c677c8eefbb601dff56f34d3dac52"; // JobFunded(uint256 indexed jobId, address indexed client, address indexed provider, uint256 amount)
const STATUS = ["OPEN", "FUNDED", "SUBMITTED", "COMPLETED", "REJECTED", "EXPIRED"] as const;

export interface OnChainJob {
  job_id: number;
  network: string;
  contract: string;
  status: (typeof STATUS)[number] | "UNKNOWN";
  client: string;
  provider: string;
  evaluator: string;
  budget_atomic: string;
  budget_u: string;
  expires_at: string | null;
  submitted_at: string | null;
  deliverable_hash: string | null;
  paid_to_provider: boolean;
  explorer: { contract: string; client: string; provider: string };
  source: string;
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
  return jobs.flatMap((j) => (j ? [{ job_id: j.job_id, status: j.status, budget_u: j.budget_u, client: j.client, submitted_at: j.submitted_at, paid_to_provider: j.paid_to_provider, funded_block: found.get(j.job_id)! }] : []));
}
