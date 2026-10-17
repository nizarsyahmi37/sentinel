/**
 * Real data sources (no API keys):
 *   - Yahoo Finance chart API  — daily prices + dividends. UNOFFICIAL, delayed;
 *     disclosed as such in every snapshot (no SLA, terms may restrict use).
 *   - FRED CSV                 — US Treasury yields (DGS10, DGS3MO). Official St. Louis Fed.
 *   - SEC EDGAR XBRL           — company facts from filed 10-K/10-Q. Official.
 * Nothing here is simulated. If a source fails, the metric is absent and the
 * snapshot says so; a labelled cached copy may be used if one exists.
 */
import type { Bar, FundamentalFacts, SeriesPoint } from "./types.js";
import { UNIVERSE, type Symbol } from "./types.js";
import { daysBetween } from "./stats.js";

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal; method?: string; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export const defaultFetch: FetchLike = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>;

export class SourceError extends Error {
  constructor(
    readonly source: string,
    message: string,
  ) {
    super(`${source}: ${message}`);
  }
}

export async function getText(f: FetchLike, source: string, url: string, headers: Record<string, string>, timeoutMs: number): Promise<string> {
  let res;
  try {
    res = await f(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new SourceError(source, e instanceof Error ? e.message : String(e));
  }
  if (!res.ok) throw new SourceError(source, `HTTP ${res.status}`);
  return res.text();
}

// ── Yahoo Finance ────────────────────────────────────────────────────────────
export interface PriceHistory {
  symbol: string;
  currency: string;
  bars: Bar[];
  dividends: { date: string; amount: number }[];
  last_price: number;
  last_time: string;
  exchange: string | null;
  url: string;
  /** Where the bars came from. Defaults to "yahoo" for cached copies that predate this field. */
  provider?: "yahoo" | "polygon";
  /** Set when a licensed provider failed and the unofficial one was used instead. */
  fallback_note?: string;
}

export const yahooUrl = (symbol: string, range = "2y") =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d&events=div`;

/** Licensed price feed (Polygon.io aggregates). The API key is sent as a bearer header and never appears in a URL, log or report. */
export const polygonUrl = (symbol: string, from: string, to: string) =>
  `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=50000`;

export function parsePolygon(symbol: string, text: string, url: string, dividends: { date: string; amount: number }[] = []): PriceHistory {
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new SourceError("Polygon.io", "response was not JSON");
  }
  if (body?.status && !["OK", "DELAYED"].includes(body.status)) throw new SourceError("Polygon.io", String(body.error ?? body.message ?? body.status));
  const bars: Bar[] = [];
  for (const r of (body?.results ?? []) as { t: number; c: number; v?: number }[]) {
    if (typeof r.c !== "number" || !Number.isFinite(r.c) || r.c <= 0 || typeof r.t !== "number") continue;
    bars.push({ date: new Date(r.t).toISOString().slice(0, 10), close: r.c, adj: r.c, volume: typeof r.v === "number" ? r.v : 0 });
  }
  const byDate = new Map(bars.map((b) => [b.date, b]));
  const clean = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (!clean.length) throw new SourceError("Polygon.io", "no usable price bars");
  const last = clean[clean.length - 1]!;
  return { symbol, currency: "USD", bars: clean, dividends, last_price: last.close, last_time: `${last.date}T00:00:00Z`, exchange: null, url, provider: "polygon" };
}

export async function fetchPolygon(f: FetchLike, symbol: string, key: string, timeoutMs = 15_000): Promise<PriceHistory> {
  const to = new Date();
  const from = new Date(to.getTime() - 740 * 86_400_000);
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const url = polygonUrl(symbol, day(from), day(to));
  const headers = { authorization: `Bearer ${key}`, accept: "application/json" };
  const text = await getText(f, "Polygon.io", url, headers, timeoutMs);
  let divs: { date: string; amount: number }[] = [];
  try {
    const dt = await getText(f, "Polygon.io", `https://api.polygon.io/v3/reference/dividends?ticker=${encodeURIComponent(symbol)}&limit=40&order=desc`, headers, timeoutMs);
    divs = ((JSON.parse(dt)?.results ?? []) as { ex_dividend_date: string; cash_amount: number }[])
      .filter((d) => d.ex_dividend_date && d.cash_amount > 0)
      .map((d) => ({ date: d.ex_dividend_date, amount: d.cash_amount }))
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    /* dividends are optional; yield is then reported missing, not guessed */
  }
  return parsePolygon(symbol, text, url, divs);
}

export const polygonKey = (): string | null => process.env.POLYGON_API_KEY?.trim() || null;

export async function fetchPrices(f: FetchLike, symbol: string, timeoutMs = 10_000): Promise<PriceHistory> {
  const key = process.env.SENTINEL_PRICE_PROVIDER === "polygon" ? polygonKey() : null;
  let fallback_note: string | undefined;
  if (process.env.SENTINEL_PRICE_PROVIDER === "polygon" && !key) fallback_note = "SENTINEL_PRICE_PROVIDER=polygon but POLYGON_API_KEY is not set; the unofficial Yahoo source was used.";
  if (key) {
    try {
      return await fetchPolygon(f, symbol, key, Math.max(timeoutMs, 15_000));
    } catch (e) {
      fallback_note = `Licensed price feed (Polygon.io) failed for ${symbol} (${e instanceof Error ? e.message : String(e)}); the unofficial Yahoo source was used instead.`;
    }
  }
  const url = yahooUrl(symbol);
  const text = await getText(f, "Yahoo Finance", url, { "user-agent": "Mozilla/5.0 (compatible; Sentinel/1.0)", accept: "application/json" }, timeoutMs);
  return { ...parseYahoo(symbol, text, url), ...(fallback_note ? { fallback_note } : {}) };
}

export function parseYahoo(symbol: string, text: string, url: string): PriceHistory {
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new SourceError("Yahoo Finance", "response was not JSON");
  }
  const r = body?.chart?.result?.[0];
  if (!r) throw new SourceError("Yahoo Finance", body?.chart?.error?.description ?? "no result");
  const ts: number[] = r.timestamp ?? [];
  const q = r.indicators?.quote?.[0] ?? {};
  const adj: (number | null)[] = r.indicators?.adjclose?.[0]?.adjclose ?? q.close ?? [];
  const bars: Bar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const close = q.close?.[i];
    const a = adj[i] ?? close;
    if (typeof close !== "number" || typeof a !== "number" || !Number.isFinite(close) || close <= 0) continue;
    bars.push({ date: new Date(ts[i]! * 1000).toISOString().slice(0, 10), close, adj: a, volume: typeof q.volume?.[i] === "number" ? q.volume[i] : 0 });
  }
  // keep one bar per date (the latest wins) in ascending order
  const byDate = new Map(bars.map((b) => [b.date, b]));
  const clean = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (clean.length === 0) throw new SourceError("Yahoo Finance", "no usable price bars");
  const divs = Object.values((r.events?.dividends ?? {}) as Record<string, { amount: number; date: number }>)
    .map((d) => ({ date: new Date(d.date * 1000).toISOString().slice(0, 10), amount: d.amount }))
    .filter((d) => Number.isFinite(d.amount) && d.amount > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  const last = clean[clean.length - 1]!;
  return {
    symbol,
    currency: String(r.meta?.currency ?? "USD"),
    bars: clean,
    dividends: divs,
    last_price: typeof r.meta?.regularMarketPrice === "number" ? r.meta.regularMarketPrice : last.close,
    last_time: typeof r.meta?.regularMarketTime === "number" ? new Date(r.meta.regularMarketTime * 1000).toISOString() : `${last.date}T00:00:00Z`,
    exchange: r.meta?.fullExchangeName ?? null,
    url,
  };
}

// ── FRED ─────────────────────────────────────────────────────────────────────
export const fredUrl = (id: string, since: string) => `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${since}`;

export async function fetchFred(f: FetchLike, id: string, now: Date, timeoutMs = 10_000): Promise<{ id: string; url: string; series: SeriesPoint[] }> {
  const since = new Date(now.getTime() - 800 * 86_400_000).toISOString().slice(0, 10);
  const url = fredUrl(id, since);
  const text = await getText(f, "FRED", url, { accept: "text/csv" }, timeoutMs);
  const series: SeriesPoint[] = [];
  for (const line of text.split(/\r?\n/u).slice(1)) {
    const [d, v] = line.split(",");
    if (!d || v === undefined || v === "." || v.trim() === "") continue;
    const n = Number(v);
    if (/^\d{4}-\d{2}-\d{2}$/u.test(d) && Number.isFinite(n)) series.push({ date: d, value: n });
  }
  if (series.length === 0) throw new SourceError("FRED", `no observations for ${id}`);
  return { id, url, series };
}

// ── SEC EDGAR ────────────────────────────────────────────────────────────────
export const secUrl = (cik: number) => `https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, "0")}.json`;
export const secUserAgent = () =>
  process.env.SENTINEL_SEC_USER_AGENT ?? `Sentinel/1.0${process.env.SENTINEL_CONTACT_EMAIL ? ` ${process.env.SENTINEL_CONTACT_EMAIL}` : ""}`;

interface Row {
  start?: string;
  end: string;
  val: number;
  accn: string;
  form: string;
  filed: string;
}

const TAGS = {
  revenue: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet", "RevenueFromContractWithCustomerIncludingAssessedTax"],
  net_income: ["NetIncomeLoss", "ProfitLoss"],
  operating_income: ["OperatingIncomeLoss"],
  eps_diluted: ["EarningsPerShareDiluted"],
  ocf: ["NetCashProvidedByUsedInOperatingActivities"],
  capex: ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"],
  cash: ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"],
  debt: ["LongTermDebt", "LongTermDebtNoncurrent"],
} as const;

function rowsOf(facts: any, tag: string): Row[] {
  const t = facts?.["us-gaap"]?.[tag];
  if (!t?.units) return [];
  const unit = t.units.USD ?? t.units["USD/shares"] ?? Object.values(t.units)[0];
  return (unit as Row[]) ?? [];
}

/** Latest filing wins for each (start,end) period, so restatements and splits are honoured. */
function dedupe(rows: Row[]): Row[] {
  const m = new Map<string, Row>();
  for (const r of rows) {
    const k = `${r.start ?? ""}|${r.end}`;
    const cur = m.get(k);
    if (!cur || r.filed > cur.filed) m.set(k, r);
  }
  return [...m.values()];
}

const dur = (r: Row) => (r.start ? daysBetween(r.start, r.end) : 0);
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

/** Trailing-twelve-month value from FY + YTD − prior-year YTD; falls back to the latest FY. */
export function ttm(rowsIn: Row[]): { value: number; period_end: string; basis: "TTM" | "FY"; accession: string; form: string; filed: string } | null {
  const rows = dedupe(rowsIn).filter((r) => r.start);
  const annual = rows.filter((r) => near(dur(r), 365, 20) && r.form.startsWith("10-K")).sort((a, b) => b.end.localeCompare(a.end))[0];
  if (!annual) return null;
  const ytd = rows
    .filter((r) => r.end > annual.end && dur(r) >= 80 && dur(r) <= 290 && r.form.startsWith("10-Q"))
    .sort((a, b) => b.end.localeCompare(a.end) || dur(b) - dur(a))[0];
  if (ytd) {
    const prior = rows.find((r) => near(daysBetween(r.end, ytd.end), 365, 12) && near(daysBetween(r.start!, ytd.start!), 365, 12) && near(dur(r), dur(ytd), 12));
    if (prior) {
      return { value: Math.round((annual.val + ytd.val - prior.val) * 1e6) / 1e6, period_end: ytd.end, basis: "TTM", accession: ytd.accn, form: ytd.form, filed: ytd.filed };
    }
  }
  return { value: annual.val, period_end: annual.end, basis: "FY", accession: annual.accn, form: annual.form, filed: annual.filed };
}

function latestInstant(rowsIn: Row[]): Row | null {
  const rows = dedupe(rowsIn).filter((r) => !r.start);
  return rows.sort((a, b) => b.end.localeCompare(a.end) || b.filed.localeCompare(a.filed))[0] ?? null;
}

function bestTag<T>(facts: any, tags: readonly string[], pick: (rows: Row[]) => T | null, endOf: (t: T) => string): T | null {
  let best: T | null = null;
  for (const tag of tags) {
    const v = pick(rowsOf(facts, tag));
    if (v && (!best || endOf(v) > endOf(best))) best = v;
  }
  return best;
}

export function extractFundamentals(json: any, cik: number): FundamentalFacts {
  const facts = json?.facts;
  const items: FundamentalFacts["items"] = {};
  let latest = "";
  const put = (k: string, v: { value: number; period_end: string; basis: "TTM" | "FY" | "instant"; accession: string; form: string; filed: string } | null) => {
    if (!v || !Number.isFinite(v.value)) return;
    items[k] = v;
    if (v.filed > latest) latest = v.filed;
  };
  for (const k of ["revenue", "net_income", "operating_income", "eps_diluted", "ocf", "capex"] as const) {
    put(k, bestTag(facts, TAGS[k], ttm, (t) => t.period_end));
  }
  // prior fiscal-year revenue for growth (latest FY vs the FY before it)
  const revRows = dedupe(
    bestTag(facts, TAGS.revenue, (rows) => (rows.length ? rows : null), (rows) => rows.map((r) => r.end).sort().pop() ?? "") ?? [],
  )
    .filter((r) => r.start && near(dur(r), 365, 20) && r.form.startsWith("10-K"))
    .sort((a, b) => b.end.localeCompare(a.end));
  if (revRows[1] && revRows[0]) {
    put("revenue_fy", { value: revRows[0].val, period_end: revRows[0].end, basis: "FY", accession: revRows[0].accn, form: revRows[0].form, filed: revRows[0].filed });
    put("revenue_fy_prior", { value: revRows[1].val, period_end: revRows[1].end, basis: "FY", accession: revRows[1].accn, form: revRows[1].form, filed: revRows[1].filed });
  }
  for (const k of ["cash", "debt"] as const) {
    const r = bestTag(facts, TAGS[k], latestInstant, (x) => x.end);
    if (r) put(k, { value: r.val, period_end: r.end, basis: "instant", accession: r.accn, form: r.form, filed: r.filed });
  }
  // Shares outstanding from the cover page; dual-class issuers report one row per class.
  const sh: Row[] = facts?.dei?.EntityCommonStockSharesOutstanding?.units?.shares ?? [];
  if (sh.length) {
    const lastEnd = [...sh].sort((a, b) => b.end.localeCompare(a.end))[0]!.end;
    const group = dedupe(sh).filter((r) => r.end === lastEnd);
    const distinct = new Map(group.map((r) => [r.val, r]));
    const total = [...distinct.keys()].reduce((s, v) => s + v, 0);
    const any = group[0]!;
    put("shares_outstanding", { value: total, period_end: lastEnd, basis: "instant", accession: any.accn, form: any.form, filed: any.filed });
  }
  return { cik, entity: String(json?.entityName ?? ""), items, latest_filed: latest };
}

export async function fetchFundamentals(f: FetchLike, symbol: Symbol, timeoutMs = 25_000): Promise<{ facts: FundamentalFacts; url: string } | null> {
  const cik = UNIVERSE[symbol].cik;
  if (cik === null) return null;
  const url = secUrl(cik);
  const text = await getText(f, "SEC EDGAR", url, { "user-agent": secUserAgent(), accept: "application/json" }, timeoutMs);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SourceError("SEC EDGAR", "response was not JSON");
  }
  return { facts: extractFundamentals(json, cik), url };
}

/** Fundamentals for any SEC registrant by CIK (used for sector peers outside the supported universe). */
export async function fetchFundamentalsByCik(f: FetchLike, cik: number, timeoutMs = 25_000): Promise<FundamentalFacts> {
  const text = await getText(f, "SEC EDGAR", secUrl(cik), { "user-agent": secUserAgent(), accept: "application/json" }, timeoutMs);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SourceError("SEC EDGAR", "response was not JSON");
  }
  return extractFundamentals(json, cik);
}

export const secSubmissionsUrl = (cik: number) => `https://data.sec.gov/submissions/CIK${String(cik).padStart(10, "0")}.json`;

/** SEC's own industry classification (Standard Industrial Classification) for a registrant. */
export async function fetchSic(f: FetchLike, cik: number, timeoutMs = 15_000): Promise<{ sic: string; description: string } | null> {
  const text = await getText(f, "SEC EDGAR", secSubmissionsUrl(cik), { "user-agent": secUserAgent(), accept: "application/json" }, timeoutMs);
  const j = JSON.parse(text) as { sic?: string; sicDescription?: string };
  return j.sic ? { sic: String(j.sic), description: String(j.sicDescription ?? "") } : null;
}

export const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";

/** Ticker → CIK map from the SEC's own registry. */
export async function fetchSecTickerMap(f: FetchLike, timeoutMs = 20_000): Promise<Map<string, { cik: number; title: string }>> {
  const text = await getText(f, "SEC EDGAR", SEC_TICKERS_URL, { "user-agent": secUserAgent(), accept: "application/json" }, timeoutMs);
  const json = JSON.parse(text) as Record<string, { cik_str: number; ticker: string; title: string }>;
  return new Map(Object.values(json).map((r) => [r.ticker.toUpperCase(), { cik: r.cik_str, title: r.title }]));
}
