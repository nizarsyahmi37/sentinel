/**
 * Read-only BNB Chain access via JSON-RPC. Sentinel NEVER signs or sends
 * transactions here: every call is eth_call / eth_getCode / eth_getStorageAt /
 * eth_getBlockByNumber. Token facts are what the chain actually says; issuer
 * claims are compared against them elsewhere.
 */
import type { TokenFacts } from "./types.js";
import { CHAINS } from "./chains.js";
import { type FetchLike, SourceError } from "./sources.js";

export const RPC_DEFAULTS: Record<string, string[]> = Object.fromEntries(Object.entries(CHAINS).map(([k, c]) => [k, c.rpcs]));

export function rpcUrls(chain: string): string[] {
  const env = CHAINS[chain] ? process.env[CHAINS[chain]!.env] : undefined;
  return env ? [env] : (RPC_DEFAULTS[chain] ?? []);
}

export type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

export function makeRpc(f: FetchLike, chain: string, timeoutMs = 8000): { rpc: Rpc; host: () => string } {
  const urls = rpcUrls(chain);
  let used = urls[0] ?? "";
  const rpc: Rpc = async (method, params) => {
    let last: unknown;
    for (const url of urls) {
      try {
        const res = await f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { result?: unknown; error?: { message: string } };
        if (body.error) throw new Error(body.error.message);
        used = url;
        return body.result;
      } catch (e) {
        last = e;
      }
    }
    throw new SourceError("BSC RPC", last instanceof Error ? last.message : "no RPC endpoints configured");
  };
  return { rpc, host: () => safeHost(used) };
}

function safeHost(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return "";
  }
}

const SIG = {
  name: "0x06fdde03",
  symbol: "0x95d89b41",
  decimals: "0x313ce567",
  totalSupply: "0x18160ddd",
  owner: "0x8da5cb5b",
  paused: "0x5c975abb",
  description: "0x7284e416",
  latestRoundData: "0xfeaf968c",
};
const SLOT_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const SLOT_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const SLOT_BEACON = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

const hex = (r: unknown): string => (typeof r === "string" ? r : "0x");

export function decodeString(h: string): string | null {
  const d = h.slice(2);
  if (d.length === 0) return null;
  try {
    if (d.length === 64) return Buffer.from(d, "hex").toString("utf8").replace(/\0+$/u, "") || null; // bytes32
    const len = parseInt(d.slice(64, 128), 16);
    if (!Number.isFinite(len) || len <= 0 || len > 512) return null;
    return Buffer.from(d.slice(128, 128 + len * 2), "hex").toString("utf8");
  } catch {
    return null;
  }
}

export function decodeUint(h: string, word = 0): bigint | null {
  const d = h.slice(2);
  if (d.length < 64 * (word + 1)) return null;
  return BigInt(`0x${d.slice(64 * word, 64 * (word + 1))}`);
}

export function decodeInt(h: string, word = 0): bigint | null {
  const u = decodeUint(h, word);
  if (u === null) return null;
  return u >= 1n << 255n ? u - (1n << 256n) : u;
}

export function decodeAddress(h: string): string | null {
  const d = h.slice(2);
  if (d.length < 64) return null;
  const a = `0x${d.slice(24, 64)}`;
  return a === ZERO_ADDR ? null : a;
}

const scale = (v: bigint, decimals: number): number => Number(v) / 10 ** decimals;

/** Collect everything Sentinel needs to know about the token contract from the chain itself. */
export async function readToken(rpc: Rpc, host: string, chain: string, address: string, feed?: string): Promise<TokenFacts> {
  const errors: string[] = [];
  const call = async (to: string, data: string): Promise<string | null> => {
    try {
      const r = hex(await rpc("eth_call", [{ to, data }, "latest"]));
      return r === "0x" ? null : r;
    } catch (e) {
      errors.push(`${data.slice(0, 10)}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };
  const quiet = async (to: string, data: string): Promise<string | null> => {
    try {
      const r = hex(await rpc("eth_call", [{ to, data }, "latest"]));
      return r === "0x" ? null : r;
    } catch {
      return null; // optional function not implemented → revert; not an error
    }
  };
  const block = (await rpc("eth_getBlockByNumber", ["latest", false])) as { number: string; timestamp: string };
  const code = hex(await rpc("eth_getCode", [address, "latest"]));
  const has_code = code !== "0x" && code.length > 2;
  const facts: TokenFacts = {
    chain, rpc_host: host, block_number: parseInt(block.number, 16), block_time: parseInt(block.timestamp, 16), has_code,
    name: null, symbol: null, decimals: null, total_supply: null, owner: null, owner_is_contract: null,
    pausable: null, paused: null, implementation: null, proxy_admin: null, redemption_signals: null, feed: null, errors,
  };
  if (!has_code) return facts;

  const nameH = await call(address, SIG.name);
  const symH = await call(address, SIG.symbol);
  const decH = await call(address, SIG.decimals);
  const supH = await call(address, SIG.totalSupply);
  facts.name = nameH ? decodeString(nameH) : null;
  facts.symbol = symH ? decodeString(symH) : null;
  const dec = decH ? decodeUint(decH) : null;
  facts.decimals = dec === null ? null : Number(dec);
  const sup = supH ? decodeUint(supH) : null;
  if (sup !== null && facts.decimals !== null) facts.total_supply = scale(sup, facts.decimals);

  const ownerH = await quiet(address, SIG.owner);
  facts.owner = ownerH ? decodeAddress(ownerH) : null;
  if (facts.owner) {
    const oc = hex(await rpc("eth_getCode", [facts.owner, "latest"]).catch(() => "0x"));
    facts.owner_is_contract = oc !== "0x" && oc.length > 2;
  }
  const pausedH = await quiet(address, SIG.paused);
  if (pausedH) {
    facts.pausable = true;
    facts.paused = (decodeUint(pausedH) ?? 0n) !== 0n;
  } else {
    facts.pausable = false;
  }
  const impl = hex(await rpc("eth_getStorageAt", [address, SLOT_IMPL, "latest"]).catch(() => "0x"));
  facts.implementation = impl.length >= 66 ? decodeAddress(`0x${impl.slice(2).padStart(64, "0")}`) : null;
  if (!facts.implementation) {
    // Beacon proxy (EIP-1967 beacon slot): the implementation is whatever the beacon currently points to.
    const bs = hex(await rpc("eth_getStorageAt", [address, SLOT_BEACON, "latest"]).catch(() => "0x"));
    const beacon = bs.length >= 66 ? decodeAddress(`0x${bs.slice(2).padStart(64, "0")}`) : null;
    if (beacon) {
      const ih = await quiet(beacon, "0x5c60da1b"); // implementation()
      facts.beacon = beacon;
      facts.implementation = ih ? decodeAddress(ih) : null;
    }
  }
  const adm = hex(await rpc("eth_getStorageAt", [address, SLOT_ADMIN, "latest"]).catch(() => "0x"));
  facts.proxy_admin = adm.length >= 66 ? decodeAddress(`0x${adm.slice(2).padStart(64, "0")}`) : null;

  // Redemption-flow capability signals: look for burn/redeem/mint entry points in the token and its implementation.
  try {
    const scanned = [address];
    let all = code.toLowerCase();
    const small = code.length / 2 < 1500; // proxies are tiny; a tiny contract with no resolved implementation cannot be scanned
    if (facts.implementation) {
      const ic = hex(await rpc("eth_getCode", [facts.implementation, "latest"]).catch(() => "0x")).toLowerCase();
      if (ic.length > 2) {
        all += ic;
        scanned.push(facts.implementation);
      }
    }
    if (small && scanned.length === 1) {
      facts.redemption_signals = null; // proxy we could not see through: unknown, not "none"
      throw new Error("unresolved-proxy");
    }
    const has = (sel: string) => all.includes(sel); // PUSH4 operand: the 4-byte selector appears verbatim in the dispatcher
    facts.redemption_signals = { burn: has("42966c68"), burn_from: has("79cc6790"), redeem: has("db006a75") || has("ba087652"), mint: has("40c10f19"), scanned };
  } catch {
    facts.redemption_signals = null;
  }
  if (feed) {
    const fc = hex(await rpc("eth_getCode", [feed, "latest"]).catch(() => "0x"));
    if (fc === "0x" || fc.length <= 2) {
      errors.push("price_feed: no contract code at the supplied feed address");
    } else {
      const fdec = await call(feed, SIG.decimals);
      const round = await call(feed, SIG.latestRoundData);
      const desc = await quiet(feed, SIG.description);
      const d = fdec ? Number(decodeUint(fdec)) : null;
      const answer = round ? decodeInt(round, 1) : null;
      const updated = round ? decodeUint(round, 3) : null;
      const rid = round ? decodeUint(round, 0) : null;
      if (d !== null && answer !== null && updated !== null && rid !== null) {
        facts.feed = { address: feed, description: desc ? decodeString(desc) : null, decimals: d, answer: scale(answer, d), updated_at: Number(updated), round_id: rid.toString() };
      } else {
        errors.push("price_feed: latestRoundData() could not be decoded");
      }
    }
  }
  return facts;
}
