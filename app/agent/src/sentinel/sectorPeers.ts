/**
 * Sector peers beyond the supported universe (FR-07). The peer lists are a
 * curated, disclosed starting point — not an official industry classification.
 * Tickers are resolved to CIKs through the SEC's own registry at run time;
 * anything that cannot be resolved or fetched is reported, never imputed.
 */
import type { PeerRow } from "./peers.js";
import { type FetchLike, defaultFetch, fetchFundamentalsByCik, fetchPrices, fetchSecTickerMap } from "./sources.js";
import { TRADING_DAYS, alignBars, annualizedVol, beta, maxDrawdown, periodReturn, simpleReturns } from "./stats.js";
import type { Bar, Symbol } from "./types.js";
import { round } from "./util.js";

export const SECTOR_PEERS: Partial<Record<Symbol, { sector: string; tickers: string[] }>> = {
  AAPL: { sector: "Consumer hardware / devices", tickers: ["HPQ", "DELL", "CSCO", "IBM"] },
  MSFT: { sector: "Enterprise software / cloud", tickers: ["ORCL", "CRM", "ADBE", "IBM"] },
  GOOGL: { sector: "Internet platforms / advertising", tickers: ["SNAP", "PINS", "TTD", "RDDT"] },
  META: { sector: "Internet platforms / advertising", tickers: ["SNAP", "PINS", "TTD", "RDDT"] },
  NVDA: { sector: "Semiconductors", tickers: ["AMD", "AVGO", "INTC", "QCOM", "MU"] },
  TSLA: { sector: "Automobiles", tickers: ["F", "GM", "RIVN", "LCID"] },
  AMZN: { sector: "Large-cap retail / e-commerce", tickers: ["WMT", "COST", "TGT", "EBAY"] },
  NFLX: { sector: "Streaming / media", tickers: ["DIS", "WBD", "ROKU", "CMCSA"] },
};

let tickerMapCache: { at: number; map: Map<string, { cik: number; title: string }> } | null = null;

export async function gatherSectorPeers(
  subject: Symbol,
  o: { fetchImpl?: FetchLike; offline?: boolean; spyBars: Bar[] },
): Promise<{ sector: string | null; rows: PeerRow[] }> {
  const cfg = SECTOR_PEERS[subject];
  if (!cfg) return { sector: null, rows: [] };
  const f = o.fetchImpl ?? defaultFetch;
  const fail = (t: string, error: string): PeerRow => ({ symbol: t, kind: "stock", status: "failed", error, values: {}, group: "sector", name: null });
  if (o.offline) return { sector: cfg.sector, rows: cfg.tickers.map((t) => fail(t, "offline mode")) };
  let map: Map<string, { cik: number; title: string }>;
  try {
    if (!o.fetchImpl && tickerMapCache && Date.now() - tickerMapCache.at < 6 * 3_600_000) map = tickerMapCache.map;
    else {
      map = await fetchSecTickerMap(f);
      if (!o.fetchImpl) tickerMapCache = { at: Date.now(), map };
    }
  } catch (e) {
    return { sector: cfg.sector, rows: cfg.tickers.map((t) => fail(t, `SEC ticker registry unavailable: ${e instanceof Error ? e.message : String(e)}`)) };
  }
  const rows = await Promise.all(
    cfg.tickers.map(async (t): Promise<PeerRow> => {
      const reg = map.get(t);
      if (!reg) return fail(t, "ticker not found in the SEC registry");
      try {
        const [ph, fund] = await Promise.all([fetchPrices(f, t), fetchFundamentalsByCik(f, reg.cik)]);
        const adj = ph.bars.map((b) => b.adj);
        if (adj.length < 120) throw new Error(`only ${adj.length} daily bars`);
        const last = ph.bars[ph.bars.length - 1]!.close;
        const g = (k: string) => fund.items[k]?.value ?? null;
        const sh = g("shares_outstanding"), eps = g("eps_diluted"), rev = g("revenue"), ni = g("net_income"), ocf = g("ocf"), cap = g("capex");
        const mcap = sh !== null ? last * sh : null;
        const fcf = ocf !== null && cap !== null ? ocf - Math.abs(cap) : null;
        const al = o.spyBars.length ? alignBars(ph.bars, o.spyBars) : null;
        const b = al ? beta(simpleReturns(al.a.slice(-(TRADING_DAYS + 1))), simpleReturns(al.b.slice(-(TRADING_DAYS + 1)))) : null;
        return {
          symbol: t, kind: "stock", status: "ok", error: null, group: "sector", name: reg.title, cik: reg.cik,
          values: {
            ret_12m: periodReturn(adj, 252), volatility_1y: annualizedVol(adj), max_drawdown_1y: maxDrawdown(adj), beta_spy_1y: b === null ? null : round(b),
            pe_ttm: eps !== null && eps > 0 ? round(last / eps) : null, ps_ttm: mcap !== null && rev ? round(mcap / rev) : null,
            fcf_yield: mcap && fcf !== null ? round(fcf / mcap) : null, net_margin: ni !== null && rev ? round(ni / rev) : null,
          },
        };
      } catch (e) {
        return fail(t, e instanceof Error ? e.message : String(e));
      }
    }),
  );
  return { sector: cfg.sector, rows };
}
