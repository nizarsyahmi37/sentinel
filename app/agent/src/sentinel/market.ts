/**
 * Market snapshot (FR-02): real prices, rates, SEC fundamentals and on-chain
 * token facts, each with source, timestamp and freshness. Nothing is simulated;
 * unavailable data becomes an explicit limitation. A labelled what-if override
 * exists only when SENTINEL_ALLOW_SIMULATION=1 (off by default).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRpc, readToken } from "./chain.js";
import {
  type FetchLike, defaultFetch, fetchFred, fetchFundamentals, fetchPrices, secUrl,
} from "./sources.js";
import { daysBetween, simpleReturns, sma } from "./stats.js";
import { chainLabel } from "./chains.js";
import {
  type Dossier, type Freshness, type MarketMetric, type MarketSnapshot, type MarketSource,
  type SeriesPoint, type SnapshotFacts, type TokenFacts, UNIVERSE,
} from "./types.js";
import { round, shortId } from "./util.js";

export interface SnapshotOptions {
  now: Date;
  fetchImpl?: FetchLike;
  cacheDir?: string;
  offline?: boolean;
  /** Labelled what-if replacement of a metric value; ignored unless simulation is allowed. */
  overrides?: Partial<Record<string, number>>;
  allowSimulation?: boolean;
  priceStaleDays?: number;
  fundamentalsStaleDays?: number;
}

const ageDays = (iso: string, now: Date) => (now.getTime() - new Date(iso).getTime()) / 86_400_000;
const addrId = (a: string | null): number => (a ? parseInt(a.slice(2, 15), 16) : 0);

interface CacheShape {
  prices?: Record<string, { at: string; value: unknown }>;
  fred?: Record<string, { at: string; value: unknown }>;
  sec?: Record<string, { at: string; value: unknown }>;
}

function readCache(dir?: string): CacheShape {
  if (!dir) return {};
  try {
    return JSON.parse(readFileSync(path.join(dir, "market-cache.json"), "utf8")) as CacheShape;
  } catch {
    return {};
  }
}
function writeCache(dir: string | undefined, c: CacheShape): void {
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "market-cache.json"), JSON.stringify(c));
  } catch {
    /* best effort */
  }
}

export async function buildMarketSnapshot(d: Pick<Dossier, "underlying" | "token">, o: SnapshotOptions): Promise<MarketSnapshot> {
  const f = o.fetchImpl ?? defaultFetch;
  const priceStale = o.priceStaleDays ?? 5;
  const fundStale = o.fundamentalsStaleDays ?? 200;
  const now = o.now;
  const limitations: string[] = [];
  const metrics: MarketMetric[] = [];
  const sources: MarketSource[] = [];
  const cache = readCache(o.cacheDir);
  const newCache: CacheShape = { prices: { ...cache.prices }, fred: { ...cache.fred }, sec: { ...cache.sec } };
  let live = 0;
  let cached = 0;
  let failed = 0;
  const u = UNIVERSE[d.underlying];
  const facts: SnapshotFacts = { bars: [], spy_bars: [], dividends: [], currency: null, fundamentals: null, token: null };

  const useCache = <T>(kind: keyof CacheShape, key: string, maxAgeDays: number, why: string, label: string): { value: T; at: string } | null => {
    failed++;
    const hit = cache[kind]?.[key];
    if (hit && ageDays(hit.at, now) <= maxAgeDays) {
      limitations.push(`${label}: live fetch failed (${why}); cached copy from ${hit.at.slice(0, 10)} used and marked stale.`);
      cached++;
      return { value: hit.value as T, at: hit.at };
    }
    limitations.push(`${label}: live fetch failed (${why}) and no usable cache; unavailable.`);
    return null;
  };

  const addPriceMetric = (key: string, label: string, sym: string, ph: { bars: SnapshotFacts["bars"]; url: string; provider?: "yahoo" | "polygon"; fallback_note?: string }, kind: MarketSource["kind"], retrieved: string) => {
    const last = ph.bars[ph.bars.length - 1]!;
const prov = ph.provider ?? "yahoo";
    const sid = `${prov}_${sym}`;
    if (ph.fallback_note && !limitations.includes(ph.fallback_note)) limitations.push(ph.fallback_note);
    sources.push(prov === "polygon"
      ? { source_id: sid, name: `Polygon.io daily aggregates — ${sym} (licensed API; split-adjusted, not dividend-adjusted)`, url: ph.url, kind, retrieved_at: retrieved, notes: "Licensed market-data API. Closes are split-adjusted only, so returns exclude dividends." }
      : { source_id: sid, name: `Yahoo Finance chart API — ${sym} (unofficial, delayed)`, url: ph.url, kind, retrieved_at: retrieved, notes: "Unofficial endpoint with no SLA; not a licensed market-data feed." });
    const stale = ageDays(`${last.date}T21:00:00Z`, now) > priceStale;
    metrics.push({
      key, label, value: last.close, unit: "USD", observation_period: last.date, observed_at: `${last.date}T21:00:00Z`, source_id: sid, kind: "observation",
      freshness: stale || kind === "cached" ? "stale" : "fresh",
      series: ph.bars.slice(-504).map((b) => ({ date: b.date, value: round(b.close, 4) })),
    });
  };

  if (!o.offline) {
    // ── prices ────────────────────────────────────────────────────────────
    const syms = d.underlying === "SPY" ? ["SPY"] : [d.underlying, "SPY"];
    for (const sym of syms) {
      try {
        const ph = await fetchPrices(f, sym);
        newCache.prices![sym] = { at: now.toISOString(), value: ph };
        live++;
        if (sym === d.underlying) {
          facts.bars = ph.bars.slice(-504);
          facts.dividends = ph.dividends;
          facts.currency = ph.currency;
          addPriceMetric("price_last", `${sym} last close`, sym, { bars: facts.bars, url: ph.url, provider: ph.provider, fallback_note: ph.fallback_note }, "live_api", now.toISOString());
          if (sym === "SPY") facts.spy_bars = facts.bars;
        } else {
          facts.spy_bars = ph.bars.slice(-504);
          addPriceMetric("spy_price", "SPY last close (market benchmark)", "SPY", { bars: facts.spy_bars, url: ph.url, provider: ph.provider, fallback_note: ph.fallback_note }, "live_api", now.toISOString());
        }
      } catch (e) {
        const hit = useCache<{ bars: SnapshotFacts["bars"]; dividends: SnapshotFacts["dividends"]; currency: string; url: string }>("prices", sym, 7, e instanceof Error ? e.message : String(e), `Yahoo Finance ${sym}`);
        if (hit) {
          if (sym === d.underlying) {
            facts.bars = hit.value.bars.slice(-504);
            facts.dividends = hit.value.dividends;
            facts.currency = hit.value.currency;
            addPriceMetric("price_last", `${sym} last close`, sym, { bars: facts.bars, url: hit.value.url, provider: (hit.value as { provider?: "yahoo" | "polygon" }).provider }, "cached", hit.at);
            if (sym === "SPY") facts.spy_bars = facts.bars;
          } else {
            facts.spy_bars = hit.value.bars.slice(-504);
            addPriceMetric("spy_price", "SPY last close (market benchmark)", "SPY", { bars: facts.spy_bars, url: hit.value.url, provider: (hit.value as { provider?: "yahoo" | "polygon" }).provider }, "cached", hit.at);
          }
        }
      }
    }
    // ── rates ─────────────────────────────────────────────────────────────
    for (const [key, id, label] of [["treasury_10y", "DGS10", "US Treasury 10-year yield"], ["rate_3m", "DGS3MO", "US Treasury 3-month yield (risk-free proxy)"]] as const) {
      let series: SeriesPoint[] | null = null;
      let url = "";
      let kind: MarketSource["kind"] = "live_api";
      let retrieved = now.toISOString();
      try {
        const r = await fetchFred(f, id, now);
        series = r.series;
        url = r.url;
        newCache.fred![id] = { at: now.toISOString(), value: r };
        live++;
      } catch (e) {
        const hit = useCache<{ series: SeriesPoint[]; url: string }>("fred", id, 14, e instanceof Error ? e.message : String(e), `FRED ${id}`);
        if (hit) {
          series = hit.value.series;
          url = hit.value.url;
          kind = "cached";
          retrieved = hit.at;
        }
      }
      if (series) {
        const last = series[series.length - 1]!;
        sources.push({ source_id: `fred_${id}`, name: `FRED (St. Louis Fed) — ${id}`, url, kind, retrieved_at: retrieved });
        metrics.push({
          key, label, value: last.value, unit: "percent", observation_period: last.date, observed_at: `${last.date}T00:00:00Z`, source_id: `fred_${id}`,
          kind: "observation", freshness: kind === "cached" || ageDays(`${last.date}T00:00:00Z`, now) > 10 ? "stale" : "fresh", series: series.slice(-260),
        });
      }
    }
    // ── SEC fundamentals ──────────────────────────────────────────────────
    if (u.kind === "stock") {
      try {
        const r = await fetchFundamentals(f, d.underlying);
        if (r) {
          facts.fundamentals = r.facts;
          newCache.sec![d.underlying] = { at: now.toISOString(), value: r.facts };
          live++;
          sources.push({ source_id: "sec_edgar", name: `SEC EDGAR XBRL company facts — ${r.facts.entity || d.underlying}`, url: r.url, kind: "live_api", retrieved_at: now.toISOString(), notes: "Filed 10-K/10-Q data; trailing-twelve-month values are computed as FY + YTD − prior-year YTD." });
        }
      } catch (e) {
        const hit = useCache<SnapshotFacts["fundamentals"]>("sec", d.underlying, 45, e instanceof Error ? e.message : String(e), "SEC EDGAR");
        if (hit?.value) {
          facts.fundamentals = hit.value;
          sources.push({ source_id: "sec_edgar", name: "SEC EDGAR XBRL company facts (cached)", url: secUrl(u.cik!), kind: "cached", retrieved_at: hit.at });
        }
      }
      if (facts.fundamentals) {
        const fund = facts.fundamentals;
        for (const [k, it] of Object.entries(fund.items)) {
          const age = ageDays(`${it.filed}T00:00:00Z`, now);
          metrics.push({
            key: `sec_${k}`, label: `${k.replace(/_/gu, " ")} (${it.basis}, period end ${it.period_end})`, value: it.value, unit: k === "eps_diluted" ? "USD/share" : k === "shares_outstanding" ? "shares" : "USD",
            observation_period: it.period_end, observed_at: `${it.filed}T00:00:00Z`, source_id: "sec_edgar", kind: "observation",
            freshness: age > fundStale ? "stale" : "fresh", provenance: { reference: `https://www.sec.gov/Archives/edgar/data/${fund.cik}/${it.accession.replace(/-/gu, "")}`, detail: `${it.form} accession ${it.accession}, filed ${it.filed}` },
          });
        }
        metrics.push({
          key: "latest_filing_date", label: "Date of the most recent SEC filing used", value: Number(fund.latest_filed.replace(/-/gu, "")), unit: "yyyymmdd", observation_period: fund.latest_filed,
          observed_at: `${fund.latest_filed}T00:00:00Z`, source_id: "sec_edgar", kind: "observation", freshness: "fresh",
        });
      }
    } else {
      limitations.push(`${d.underlying} is an ETF: it files no company financial statements, so fundamentals (earnings, cash flow, balance sheet) are not assessed; see the ETF look-through section for holdings.`);
    }
    // dividends (real, from the price source)
    const yearAgo = new Date(now.getTime() - 365 * 86_400_000).toISOString().slice(0, 10);
    const dividendTtm = facts.dividends.filter((x) => x.date >= yearAgo).reduce((s, x) => s + x.amount, 0);
    if (facts.bars.length && dividendTtm > 0) {
      metrics.push({ key: "dividend_ttm", label: "Dividends per share, last 12 months", value: round(dividendTtm, 4), unit: "USD/share", observation_period: `${yearAgo}→${facts.bars[facts.bars.length - 1]!.date}`, observed_at: `${facts.bars[facts.bars.length - 1]!.date}T00:00:00Z`, source_id: `yahoo_${d.underlying}`, kind: "observation", freshness: "fresh" });
    }
    // ── on-chain token ────────────────────────────────────────────────────
    if (d.token) {
      try {
        const { rpc, host } = makeRpc(f, d.token.chain);
        const tf: TokenFacts = await readToken(rpc, host(), d.token.chain, d.token.contract_address, d.token.price_feed);
        facts.token = tf;
        live++;
        const sid = "bsc_rpc";
        sources.push({ source_id: sid, name: `${chainLabel(d.token.chain)} JSON-RPC (${tf.rpc_host})`, url: null, kind: "on_chain", retrieved_at: now.toISOString(), notes: `Read-only calls at block ${tf.block_number}. Sentinel never signs or sends transactions.` });
        const when = new Date(tf.block_time * 1000).toISOString();
        const prov = { reference: `block ${tf.block_number}`, detail: `${d.token.chain} ${d.token.contract_address}` };
        if (tf.total_supply !== null) metrics.push({ key: "token_total_supply", label: "Token total supply (on-chain)", value: tf.total_supply, unit: "tokens", observation_period: `block ${tf.block_number}`, observed_at: when, source_id: sid, kind: "observation", freshness: "fresh", provenance: prov });
        if (tf.implementation) metrics.push({ key: "token_impl_id", label: "Token implementation address id (changes if the contract is upgraded)", value: addrId(tf.implementation), unit: "id", observation_period: `block ${tf.block_number}`, observed_at: when, source_id: sid, kind: "observation", freshness: "fresh", provenance: { reference: tf.implementation, detail: "EIP-1967 implementation slot" } });
        if (tf.feed) {
          const feedAgeDays = (tf.block_time - tf.feed.updated_at) / 86_400;
          metrics.push({ key: "token_feed_price", label: `On-chain price feed ${tf.feed.description ?? tf.feed.address}`, value: tf.feed.answer, unit: "USD", observation_period: `round ${tf.feed.round_id}`, observed_at: new Date(tf.feed.updated_at * 1000).toISOString(), source_id: sid, kind: "observation", freshness: feedAgeDays > 4 ? "stale" : "fresh", provenance: { reference: tf.feed.address, detail: `latestRoundData round ${tf.feed.round_id}` } });
        }
      } catch (e) {
        failed++;
        limitations.push(`${chainLabel(d.token.chain)} RPC unavailable (${e instanceof Error ? e.message : String(e)}); token verification could not be performed.`);
      }
    }
  } else {
    limitations.push("Offline mode: no live sources were queried.");
  }

  // ── controlled what-if (OFF by default; never presented as an observation) ──
  let simulated = false;
  if (o.allowSimulation) {
    for (const [key, value] of Object.entries(o.overrides ?? {})) {
      const i = metrics.findIndex((m) => m.key === key);
      if (i === -1 || typeof value !== "number" || !Number.isFinite(value)) continue;
      const m = metrics[i]!;
      metrics[i] = { ...m, value, label: `${m.label} (WHAT-IF, not observed)`, observed_at: now.toISOString(), source_id: "what_if", series: undefined };
      simulated = true;
    }
    if (simulated) {
      sources.push({ source_id: "what_if", name: "Controlled what-if change", url: null, kind: "cached", retrieved_at: now.toISOString(), notes: "Hypothetical replacement for testing monitoring; not an observation." });
      limitations.push("One or more metrics were replaced by a WHAT-IF value; this snapshot is not an observation.");
    }
  }

  if (!o.offline) writeCache(o.cacheDir, newCache);
  const quality: MarketSnapshot["data_quality_status"] = metrics.length === 0 ? "unavailable" : live > 0 && failed === 0 && !simulated ? "live" : live > 0 ? "partial" : "cached";
  const observedAt = metrics.length ? metrics.map((m) => m.observed_at).sort().pop()! : now.toISOString();
  const core = {
    underlying: d.underlying,
    token_chain: d.token?.chain ?? null,
    observation_period: facts.bars.length ? facts.bars[facts.bars.length - 1]!.date : now.toISOString().slice(0, 10),
    metrics, sources, observed_at: observedAt, data_quality_status: quality, limitations, facts,
  };
  return { snapshot_id: shortId("market", { m: metrics.map((x) => [x.key, x.value, x.observed_at]), t: facts.token?.block_number ?? null, sim: simulated }), ...core };
}

// ── Market analysis ──────────────────────────────────────────────────────────
export interface MarketDriver {
  driver: string;
  direction: "favorable" | "neutral" | "unfavorable";
  basis: string;
}

export interface MarketAnalysis {
  attractiveness: { label: "favorable" | "neutral" | "unfavorable" | "unknown"; drivers: MarketDriver[]; rule: string };
  rates: { treasury_10y: number | null; rate_3m: number | null; curve_spread_pp: number | null; change_3m_pp: number | null };
  limitations: string[];
}

/** Broad-market and rates context. Context only: it can downgrade a status, never upgrade it. */
export function analyzeMarket(s: MarketSnapshot): MarketAnalysis {
  const drivers: MarketDriver[] = [];
  const spy = s.facts.spy_bars.map((b) => b.adj);
  if (spy.length >= 200) {
    const last = spy[spy.length - 1]!;
    const s200 = sma(spy, 200)!;
    const hi = Math.max(...spy.slice(-252));
    drivers.push({
      driver: "Broad-market trend (SPY)",
      direction: last > s200 ? "favorable" : "unfavorable",
      basis: `SPY ${round(last, 2)} is ${last > s200 ? "above" : "below"} its 200-day average ${round(s200, 2)}.`,
    });
    const dd = 1 - last / hi;
    drivers.push({
      driver: "Broad-market drawdown",
      direction: dd < 0.05 ? "favorable" : dd > 0.15 ? "unfavorable" : "neutral",
      basis: `SPY is ${round(dd * 100, 1)}% below its 52-week closing high.`,
    });
    const r = simpleReturns(spy.slice(-253));
    const m12 = spy.length > 252 ? spy[spy.length - 1]! / spy[spy.length - 253]! - 1 : null;
    if (m12 !== null) drivers.push({ driver: "Broad-market 12-month return", direction: m12 > 0.05 ? "favorable" : m12 < -0.05 ? "unfavorable" : "neutral", basis: `SPY 12-month return ${round(m12 * 100, 1)}% (${r.length} daily observations).` });
  }
  const y10 = s.metrics.find((m) => m.key === "treasury_10y");
  const m3 = s.metrics.find((m) => m.key === "rate_3m");
  let change3m: number | null = null;
  if (y10?.series) {
    const cutoff = new Date(y10.observed_at);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - 3);
    const past = [...y10.series].reverse().find((p) => new Date(p.date) <= cutoff);
    if (past) {
      change3m = round(y10.value - past.value, 4);
      drivers.push({ driver: "Long-term rates (10-year yield)", direction: change3m < -0.15 ? "favorable" : change3m > 0.25 ? "unfavorable" : "neutral", basis: `10-year yield ${y10.value}% vs ${past.value}% on ${past.date} (${change3m >= 0 ? "+" : ""}${change3m} pp).` });
    }
  }
  const spread = y10 && m3 ? round(y10.value - m3.value, 4) : null;
  if (spread !== null) drivers.push({ driver: "Yield curve (10-year minus 3-month)", direction: spread < 0 ? "unfavorable" : "neutral", basis: `Spread ${spread} pp${spread < 0 ? " (inverted)" : ""}.` });
  const score = drivers.reduce((a, d) => a + (d.direction === "favorable" ? 1 : d.direction === "unfavorable" ? -1 : 0), 0);
  return {
    attractiveness: {
      label: drivers.length < 2 ? "unknown" : score >= 2 ? "favorable" : score <= -2 ? "unfavorable" : "neutral",
      drivers,
      rule: "Favorable minus unfavorable drivers: ≥ +2 favorable, ≤ −2 unfavorable, otherwise neutral; fewer than 2 drivers → unknown. Context only; it can downgrade a status but never upgrade it or offset a token-structure or evidence concern.",
    },
    rates: { treasury_10y: y10?.value ?? null, rate_3m: m3?.value ?? null, curve_spread_pp: spread, change_3m_pp: change3m },
    limitations: s.limitations,
  };
}

export { daysBetween as _daysBetween };
export type { Freshness };
