import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fetchEtfHoldings, lookThroughOf, parseHoldingsCsv } from "../src/sentinel/holdings.js";

const csv = (n: number) => ["Fund Ticker,Holding Ticker,Name,Weight %", ...Array.from({ length: n }, (_, i) => `QQQ,"T${i}","Company ${i}, Inc.",${i === 0 ? 10 : (90 / (n - 1)).toFixed(4)}`)].join("\n");

describe("operator-supplied ETF holdings file (e.g. QQQ)", () => {
  it("parses a CSV with quoted commas and percent weights", () => {
    const h = parseHoldingsCsv(csv(60), "QQQ", "u");
    assert.equal(h.count, 60);
    assert.equal(h.holdings[0]!.ticker, "T0");
    assert.equal(h.holdings[0]!.weight, 0.1);
    assert.equal(h.holdings[1]!.name, "Company 1, Inc.");
    assert.ok(Math.abs(h.total_weight - 1) < 1e-3);
    assert.throws(() => parseHoldingsCsv("a,b\n1,2", "QQQ", "u"), /header with ticker and weight/u);
    assert.throws(() => parseHoldingsCsv(csv(10), "QQQ", "u"), /only 10 holdings/u);
  });

  it("reads QQQ from a local file path set in SENTINEL_HOLDINGS_URL_QQQ; a missing file is an honest error", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hf-"));
    const file = path.join(dir, "qqq.csv");
    writeFileSync(file, csv(101));
    process.env.SENTINEL_HOLDINGS_URL_QQQ = file;
    try {
      const lt = await lookThroughOf("QQQ");
      assert.equal(lt.status, "ok");
      assert.equal(lt.count, 101);
      assert.equal(lt.top[0]!.ticker, "T0");
      process.env.SENTINEL_HOLDINGS_URL_QQQ = path.join(dir, "missing.csv");
      await assert.rejects(fetchEtfHoldings("QQQ", (async () => ({ ok: false, status: 500 })) as never), /cannot read/u);
    } finally {
      delete process.env.SENTINEL_HOLDINGS_URL_QQQ;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
