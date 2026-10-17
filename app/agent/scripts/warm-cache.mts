/**
 * Pre-warm Sentinel's market cache with REAL data for the whole universe so a
 * venue-network failure degrades to labelled "cached, stale" data instead of
 * INSUFFICIENT_DATA. Nothing is invented: the cache is exactly what Yahoo, FRED
 * and SEC EDGAR returned just now, and reports built from it say so.
 *   SENTINEL_DATA_DIR=/path npx tsx scripts/warm-cache.mts
 */
import path from "node:path";
import { buildMarketSnapshot } from "../src/sentinel/market.js";
import { DossierSchema, SYMBOLS } from "../src/sentinel/types.js";

const dataDir = process.env.SENTINEL_DATA_DIR ?? path.resolve(process.cwd(), ".sentinel-data");
const cacheDir = path.join(dataDir, "_cache");
let ok = 0;
for (const sym of SYMBOLS) {
  const s = await buildMarketSnapshot(DossierSchema.parse({ underlying: sym }), { now: new Date(), cacheDir });
  const good = s.data_quality_status === "live";
  if (good) ok++;
  console.log(`${sym.padEnd(6)} ${s.data_quality_status}${s.limitations.length ? ` — ${s.limitations[0]}` : ""}`);
}
console.log(`cache written to ${cacheDir} (${ok}/${SYMBOLS.length} live)`);
process.exit(ok === SYMBOLS.length ? 0 : 1);
