/**
 * Test-only fakes. They are deterministic stand-ins for the network so unit
 * tests don't depend on live services; NOTHING here ships in the runtime.
 */
import type { FetchLike } from "../src/sentinel/sources.js";

export function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());

export function weekdays(n: number, endISO = "2026-10-14"): string[] {
  const out: string[] = [];
  const d = new Date(`${endISO}T00:00:00Z`);
  while (out.length < n) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.unshift(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}

export interface FakeMarket {
  dates: string[];
  spy: number[];
  assets: Record<string, number[]>;
}

export function fakeMarket(betas: Record<string, number> = { AAPL: 1.1 }, n = 520, endISO = "2026-10-14"): FakeMarket {
  const dates = weekdays(n, endISO);
  const r = lcg(42);
  const spyRets = dates.map(() => 0.0010 + 0.008 * gauss(r));
  const px = (rets: number[], start: number) => rets.reduce<number[]>((a, x) => (a.push((a.length ? a[a.length - 1]! : start) * (1 + x)), a), []);
  const assets: Record<string, number[]> = {};
  for (const [sym, b] of Object.entries(betas)) {
    const rr = lcg(sym.charCodeAt(0) * 7 + 1);
    assets[sym] = px(spyRets.map((x) => b * x + 0.006 * gauss(rr)), 150);
  }
  return { dates, spy: px(spyRets, 400), assets };
}

function yahooBody(sym: string, dates: string[], closes: number[], withDividends: boolean) {
  const ts = dates.map((d) => Date.parse(`${d}T14:30:00Z`) / 1000);
  const divs: Record<string, { amount: number; date: number }> = {};
  if (withDividends) for (const i of [dates.length - 200, dates.length - 140, dates.length - 80, dates.length - 20]) divs[String(ts[i])] = { amount: 0.25, date: ts[i]! };
  return {
    chart: { result: [{ meta: { currency: "USD", symbol: sym, regularMarketPrice: closes[closes.length - 1], regularMarketTime: ts[ts.length - 1], fullExchangeName: "NasdaqGS" }, timestamp: ts, indicators: { quote: [{ close: closes, volume: closes.map(() => 5_000_000) }], adjclose: [{ adjclose: closes }] }, events: { dividends: divs } }], error: null },
  };
}

export interface FakeTokenSpec {
  address: string;
  code?: boolean;
  bytecode?: string;
  name?: string;
  symbol?: string;
  decimals?: number;
  totalSupply?: bigint;
  owner?: string | null;
  ownerIsContract?: boolean;
  pausable?: boolean;
  paused?: boolean;
  implementation?: string | null;
  admin?: string | null;
  feed?: { address: string; answer: number; decimals: number; updatedAt: number; description?: string } | null;
}

const pad = (h: string) => h.replace(/^0x/u, "").padStart(64, "0");
const encStr = (s: string) => `0x${pad("20")}${pad(s.length.toString(16))}${Buffer.from(s).toString("hex").padEnd(Math.ceil(s.length / 32) * 64, "0")}`;
const encUint = (n: bigint | number) => `0x${pad(BigInt(n).toString(16))}`;

export interface FakeNet {
  market?: FakeMarket;
  token?: FakeTokenSpec;
  fail?: Partial<Record<"yahoo" | "fred" | "sec" | "rpc", boolean>>;
  secFacts?: unknown;
  yield10?: number;
  blockTime?: number;
  calls: string[];
}

export function fakeSec(): unknown {
  const row = (start: string | null, end: string, val: number, form: string, filed: string, accn: string) => ({ ...(start ? { start } : {}), end, val, accn, fy: 2026, fp: form === "10-K" ? "FY" : "Q3", form, filed });
  const dur = (tag: string, unit: string, fy: number, ytd: number, pytd: number) => ({
    [tag]: { units: { [unit]: [row("2024-09-29", "2025-09-27", fy, "10-K", "2025-10-31", "0000320193-25-000079"), row("2025-09-28", "2026-06-27", ytd, "10-Q", "2026-07-31", "0000320193-26-000020"), row("2024-09-29", "2025-06-28", pytd, "10-Q", "2025-08-01", "0000320193-25-000057"), row("2024-09-29", "2025-06-28", pytd, "10-Q", "2026-07-31", "0000320193-26-000020")] } },
  });
  return {
    cik: 320193, entityName: "Fake Corp",
    facts: {
      dei: { EntityCommonStockSharesOutstanding: { units: { shares: [row(null, "2026-07-17", 1_000_000_000, "10-Q", "2026-07-31", "0000320193-26-000020")] } } },
      "us-gaap": {
        ...dur("RevenueFromContractWithCustomerExcludingAssessedTax", "USD", 400e9, 330e9, 300e9),
        ...dur("NetIncomeLoss", "USD", 100e9, 90e9, 80e9),
        ...dur("OperatingIncomeLoss", "USD", 120e9, 100e9, 90e9),
        ...dur("EarningsPerShareDiluted", "USD/shares", 6.5, 5.0, 4.5),
        ...dur("NetCashProvidedByUsedInOperatingActivities", "USD", 110e9, 95e9, 85e9),
        ...dur("PaymentsToAcquirePropertyPlantAndEquipment", "USD", 12e9, 9e9, 8e9),
        CashAndCashEquivalentsAtCarryingValue: { units: { USD: [row(null, "2026-06-27", 40e9, "10-Q", "2026-07-31", "0000320193-26-000020"), row(null, "2025-09-27", 35e9, "10-K", "2025-10-31", "0000320193-25-000079")] } },
        LongTermDebt: { units: { USD: [row(null, "2026-06-27", 80e9, "10-Q", "2026-07-31", "0000320193-26-000020")] } },
        // prior fiscal year for growth
        Revenues: { units: { USD: [row("2023-10-01", "2024-09-28", 380e9, "10-K", "2024-11-01", "0000320193-24-000123")] } },
      },
    },
  };
}

/** Prior-FY revenue lives under the same tag in real filings; add it for growth checks. */
export function fakeSecWithPriorFy(): any {
  const s = fakeSec() as any;
  s.facts["us-gaap"].RevenueFromContractWithCustomerExcludingAssessedTax.units.USD.push({ start: "2023-10-01", end: "2024-09-28", val: 380e9, accn: "0000320193-24-000123", fy: 2024, fp: "FY", form: "10-K", filed: "2024-11-01" });
  return s;
}

export function makeFetch(net: FakeNet): FetchLike {
  return async (url, init) => {
    net.calls.push(url);
    const ok = (body: unknown, text?: string) => ({ ok: true, status: 200, json: async () => body, text: async () => text ?? JSON.stringify(body) });
    const bad = (status = 503) => ({ ok: false, status, json: async () => ({}), text: async () => "" });
    if (url.includes("query1.finance.yahoo.com")) {
      if (net.fail?.yahoo) return bad();
      const m = net.market!;
      const sym = decodeURIComponent(/chart\/([^?]+)/u.exec(url)![1]!);
      const closes = sym === "SPY" ? m.spy : m.assets[sym];
      if (!closes) return bad(404);
      return ok(yahooBody(sym, m.dates, closes, sym !== "SPY"));
    }
    if (url.includes("fredgraph.csv")) {
      if (net.fail?.fred) return bad();
      const id = /id=([A-Z0-9]+)/u.exec(url)![1]!;
      const y = id === "DGS10" ? (net.yield10 ?? 4.5) : 4.0;
      const rows = ["DATE," + id, "2026-07-14," + (y - 0.3), "2026-09-14," + (y - 0.1), "2026-10-13," + y, "2026-10-14,."];
      return ok({}, rows.join("\n"));
    }
    if (url.includes("company_tickers.json")) {
      if (net.fail?.sec) return bad();
      return ok({ "0": { cik_str: 2488, ticker: "AMD", title: "ADVANCED MICRO DEVICES INC" }, "1": { cik_str: 1730168, ticker: "AVGO", title: "BROADCOM INC." }, "2": { cik_str: 50863, ticker: "INTC", title: "INTEL CORP" } });
    }
    if (url.includes("data.sec.gov")) {
      if (net.fail?.sec) return bad();
      return ok(net.secFacts ?? fakeSecWithPriorFy());
    }
    if (init?.method === "POST") {
      if (net.fail?.rpc) return bad();
      const { method, params } = JSON.parse(init.body!) as { method: string; params: any[] };
      const t = net.token;
      const res = (result: unknown) => ok({ jsonrpc: "2.0", id: 1, result });
      if (method === "eth_getBlockByNumber") return res({ number: "0x10", timestamp: `0x${(net.blockTime ?? 1_792_150_000).toString(16)}` });
      if (method === "eth_getCode") {
        const a = String(params[0]).toLowerCase();
        if (t && a === t.address.toLowerCase()) return res(t.code === false ? "0x" : (t.bytecode ?? "0x6080"));
        if (t?.feed && a === t.feed.address.toLowerCase()) return res("0x6080");
        if (t?.owner && a === t.owner.toLowerCase()) return res(t.ownerIsContract ? "0x6080" : "0x");
        return res("0x");
      }
      if (method === "eth_getStorageAt") {
        const slot = String(params[1]);
        if (slot.startsWith("0x360894")) return res(t?.implementation ? `0x${pad(t.implementation)}` : `0x${"0".repeat(64)}`);
        return res(t?.admin ? `0x${pad(t.admin)}` : `0x${"0".repeat(64)}`);
      }
      if (method === "eth_call") {
        const { to, data } = params[0] as { to: string; data: string };
        const sel = data.slice(0, 10);
        const a = to.toLowerCase();
        if (t?.feed && a === t.feed.address.toLowerCase()) {
          if (sel === "0x313ce567") return res(encUint(t.feed.decimals));
          if (sel === "0x7284e416") return res(encStr(t.feed.description ?? "AAPL / USD"));
          if (sel === "0xfeaf968c") return res(`0x${pad("1")}${pad(BigInt(Math.round(t.feed.answer * 10 ** t.feed.decimals)).toString(16))}${pad("1")}${pad(t.feed.updatedAt.toString(16))}${pad("1")}`);
        }
        if (t && a === t.address.toLowerCase()) {
          if (sel === "0x06fdde03") return res(encStr(t.name ?? "Fake Token"));
          if (sel === "0x95d89b41") return res(encStr(t.symbol ?? "FAKE"));
          if (sel === "0x313ce567") return res(encUint(t.decimals ?? 18));
          if (sel === "0x18160ddd") return res(encUint(t.totalSupply ?? 0n));
          if (sel === "0x8da5cb5b" && t.owner) return res(`0x${pad(t.owner)}`);
          if (sel === "0x5c975abb" && t.pausable) return res(encUint(t.paused ? 1 : 0));
        }
        return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, error: { message: "execution reverted" } }), text: async () => "" };
      }
    }
    return bad(404);
  };
}

export function newNet(over: Partial<FakeNet> = {}): FakeNet {
  return { market: fakeMarket({ AAPL: 1.1, NVDA: 1.6, QQQ: 1.1, SPY: 1 }), calls: [], ...over };
}

export const TOKEN_ADDR = "0x1111111111111111111111111111111111111111";
export const FEED_ADDR = "0x2222222222222222222222222222222222222222";
export const OWNER_ADDR = "0x3333333333333333333333333333333333333333";
export const IMPL_ADDR = "0x4444444444444444444444444444444444444444";
