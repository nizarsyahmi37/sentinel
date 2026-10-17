/**
 * ETF look-through from the issuer's own published daily holdings file.
 * SPY: State Street (SSGA) daily holdings workbook. QQQ: Invesco blocks
 * automated downloads, so look-through for QQQ is reported unavailable
 * rather than approximated.
 */
import { inflateRawSync } from "node:zlib";
import { type FetchLike, SourceError, defaultFetch } from "./sources.js";
import { round } from "./util.js";

export interface EtfHolding {
  ticker: string;
  name: string;
  weight: number; // fraction of fund, 0..1
}
export interface EtfHoldings {
  etf: string;
  as_of: string | null;
  source_url: string;
  count: number;
  holdings: EtfHolding[];
  top10_weight: number;
  total_weight: number;
}

export const HOLDINGS_SOURCES: Record<string, { url: string; issuer: string } | undefined> = {
  SPY: { url: "https://www.ssga.com/library-content/products/fund-data/etfs/us/holdings-daily-us-en-spy.xlsx", issuer: "State Street Global Advisors" },
};

// ── minimal zip + xlsx reader (no dependency) ───────────────────────────────
function unzip(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70_000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip archive");
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt zip directory");
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    const lh = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const raw = buf.subarray(lh, lh + csize);
    if (name === "xl/sharedStrings.xml" || name.startsWith("xl/worksheets/sheet")) out.set(name, method === 0 ? raw : inflateRawSync(raw));
    p += 46 + nlen + elen + clen;
  }
  return out;
}

const unesc = (s: string) => s.replace(/&amp;/gu, "&").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&quot;/gu, '"').replace(/&apos;/gu, "'");

export function parseHoldingsXlsx(buf: Buffer, etf: string, url: string): EtfHoldings {
  const files = unzip(buf);
  const ssXml = files.get("xl/sharedStrings.xml")?.toString("utf8") ?? "";
  const ss = [...ssXml.matchAll(/<si>([\s\S]*?)<\/si>/gu)].map((m) => unesc(m[1]!.replace(/<[^>]+>/gu, "")));
  const sheet = files.get("xl/worksheets/sheet1.xml")?.toString("utf8");
  if (!sheet) throw new Error("worksheet not found");
  const rows: Record<string, string>[] = [];
  for (const r of sheet.matchAll(/<row r="\d+"[^>]*>([\s\S]*?)<\/row>/gu)) {
    const row: Record<string, string> = {};
    for (const c of r[1]!.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>(?:<f>[\s\S]*?<\/f>)?(?:<v>([\s\S]*?)<\/v>)?(?:<is>([\s\S]*?)<\/is>)?<\/c>)/gu)) {
      const [, col, attr, v, inl] = c;
      row[col!] = attr!.includes('t="s"') && v !== undefined ? (ss[Number(v)] ?? "") : inl ? unesc(inl.replace(/<[^>]+>/gu, "")) : (v ?? "");
    }
    rows.push(row);
  }
  const h = rows.findIndex((r) => Object.values(r).includes("Ticker") && Object.values(r).includes("Weight"));
  if (h < 0) throw new Error("holdings header row not found");
  const col = (name: string) => Object.entries(rows[h]!).find(([, v]) => v === name)?.[0];
  const cn = col("Name"), ct = col("Ticker"), cw = col("Weight");
  if (!cn || !ct || !cw) throw new Error("expected Name/Ticker/Weight columns");
  const asOf = rows.map((r) => Object.values(r).find((v) => /^As of /u.test(v))).find(Boolean)?.replace(/^As of /u, "") ?? null;
  const holdings: EtfHolding[] = [];
  for (const r of rows.slice(h + 1)) {
    const w = Number(r[cw]);
    const t = (r[ct] ?? "").trim();
    if (!t || t === "-" || !Number.isFinite(w) || w <= 0) continue;
    holdings.push({ ticker: t.toUpperCase(), name: r[cn] ?? "", weight: w / 100 });
  }
  if (holdings.length < 50) throw new Error(`only ${holdings.length} holdings parsed`);
  holdings.sort((a, b) => b.weight - a.weight);
  const total = holdings.reduce((s, x) => s + x.weight, 0);
  return { etf, as_of: asOf, source_url: url, count: holdings.length, holdings, top10_weight: round(holdings.slice(0, 10).reduce((s, x) => s + x.weight, 0)), total_weight: round(total) };
}

/** CSV holdings (e.g. an issuer's "download holdings" file): needs a ticker column and a weight column (percent). */
export function parseHoldingsCsv(text: string, etf: string, url: string): EtfHoldings {
  const lines = text.split(/\r?\n/u).map((l) => l.trim()).filter(Boolean);
  const split = (l: string) => (l.match(/("([^"]|"")*"|[^,]*)(,|$)/gu) ?? []).map((c) => c.replace(/,$/u, "").replace(/^"|"$/gu, "").replace(/""/gu, '"').trim());
  const h = lines.findIndex((l) => /ticker|symbol/iu.test(l) && /weight|%/iu.test(l));
  if (h < 0) throw new Error("CSV needs a header with ticker and weight columns");
  const head = split(lines[h]!).map((x) => x.toLowerCase());
  // Prefer the constituent's ticker over the fund's own ticker column, and "weight" over a bare "%".
  const pick = (re: RegExp, not?: RegExp) => { const i = head.findIndex((x) => re.test(x) && !(not && not.test(x))); return i >= 0 ? i : head.findIndex((x) => re.test(x)); };
  const ct = pick(/ticker|symbol/u, /fund|etf/u);
  const cw = pick(/weight/u) >= 0 ? pick(/weight/u) : pick(/%/u);
  const cn = head.findIndex((x) => /^(name|holding name|security name|description)$/u.test(x));
  const holdings: EtfHolding[] = [];
  for (const l of lines.slice(h + 1)) {
    const c = split(l);
    const w = Number((c[cw] ?? "").replace(/%/gu, ""));
    const t = (c[ct] ?? "").trim();
    if (t && t !== "-" && Number.isFinite(w) && w > 0) holdings.push({ ticker: t.toUpperCase(), name: cn >= 0 ? (c[cn] ?? "") : "", weight: w / 100 });
  }
  if (holdings.length < 50) throw new Error(`only ${holdings.length} holdings parsed`);
  holdings.sort((a, b) => b.weight - a.weight);
  const total = holdings.reduce((s, x) => s + x.weight, 0);
  return { etf, as_of: null, source_url: url, count: holdings.length, holdings, top10_weight: round(holdings.slice(0, 10).reduce((s, x) => s + x.weight, 0)), total_weight: round(total) };
}

const cache = new Map<string, { at: number; value: EtfHoldings }>();

export async function fetchEtfHoldings(etf: string, f: FetchLike = defaultFetch, timeoutMs = 25_000): Promise<EtfHoldings> {
  const envUrl = process.env[`SENTINEL_HOLDINGS_URL_${etf}`];
  const src = envUrl ? { url: envUrl, issuer: "operator-supplied" } : HOLDINGS_SOURCES[etf];
  if (!src) throw new SourceError("ETF holdings", `no accessible official holdings file for ${etf}; look-through unavailable`);
  const hit = cache.get(etf);
  if (hit && Date.now() - hit.at < 6 * 3_600_000 && f === defaultFetch) return hit.value;
  if (/^(file:\/\/|\/)/u.test(src.url)) {
    // Operator-supplied local file (e.g. a holdings CSV/XLSX downloaded from the issuer in a browser).
    const { readFile } = await import("node:fs/promises");
    const buf = await readFile(src.url.replace(/^file:\/\//u, "")).catch((e: Error) => { throw new SourceError("ETF holdings", `cannot read ${src.url}: ${e.message}`); });
    const v = buf.subarray(0, 2).toString("latin1") === "PK" ? parseHoldingsXlsx(buf, etf, src.url) : parseHoldingsCsv(buf.toString("utf8"), etf, src.url);
    if (f === defaultFetch) cache.set(etf, { at: Date.now(), value: v });
    return v;
  }
  let res;
  try {
    res = await f(src.url, { headers: { "user-agent": "Mozilla/5.0 (compatible; Sentinel/1.0)" }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new SourceError("ETF holdings", e instanceof Error ? e.message : String(e));
  }
  if (!res.ok) throw new SourceError("ETF holdings", `HTTP ${res.status}`);
  const bin = (res as unknown as { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer;
  if (!bin) throw new SourceError("ETF holdings", "binary response not supported by fetch implementation");
  const buf = Buffer.from(await bin.call(res));
  const value = buf.subarray(0, 2).toString("latin1") === "PK" ? parseHoldingsXlsx(buf, etf, src.url) : parseHoldingsCsv(buf.toString("utf8"), etf, src.url);
  if (f === defaultFetch) cache.set(etf, { at: Date.now(), value });
  return value;
}

export interface LookThrough {
  status: "ok" | "unavailable";
  etf: string;
  reason: string | null;
  as_of: string | null;
  source_url: string | null;
  count: number | null;
  top10_weight: number | null;
  top: EtfHolding[];
}

export async function lookThroughOf(etf: string, f?: FetchLike): Promise<LookThrough> {
  try {
    const h = await fetchEtfHoldings(etf, f);
    return { status: "ok", etf, reason: null, as_of: h.as_of, source_url: h.source_url, count: h.count, top10_weight: h.top10_weight, top: h.holdings.slice(0, 15).map((x) => ({ ...x, weight: round(x.weight) })) };
  } catch (e) {
    return { status: "unavailable", etf, reason: e instanceof Error ? e.message : String(e), as_of: null, source_url: HOLDINGS_SOURCES[etf]?.url ?? null, count: null, top10_weight: null, top: [] };
  }
}
