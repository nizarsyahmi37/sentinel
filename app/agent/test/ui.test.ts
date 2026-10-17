import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UI_HTML } from "../src/sentinel/ui.js";
import { renderReportHtml } from "../src/sentinel/reportHtml.js";
import { runAssessment } from "../src/sentinel/pipeline.js";
import { makeFetch, newNet } from "./helpers.js";

describe("web UI & report rendering", () => {
  it("the inline script is syntactically valid JavaScript", () => {
    const script = /<script>([\s\S]*)<\/script>/.exec(UI_HTML)![1]!;
    assert.doesNotThrow(() => new Function(script));
  });
  it("lists all ten tickers and all six tabs", () => {
    for (const s of ["AAPL", "GOOGL", "NVDA", "META", "TSLA", "AMZN", "NFLX", "MSFT", "QQQ", "SPY"]) assert.ok(UI_HTML.includes(`"${s}"`), s);
    for (const t of ["Assess", "Market", "Token & underlying", "Report", "Agent service", "Monitoring"]) assert.ok(UI_HTML.includes(t), t);
    assert.ok(!/property|rent roll|DSCR|cap rate/i.test(UI_HTML));
  });
  it("the standalone report escapes dynamic text", async () => {
    const r = await runAssessment({ underlying: "AAPL", assumptions: ["<img src=x onerror=alert(1)>"] }, { now: new Date("2026-10-17T03:00:00Z"), fetchImpl: makeFetch(newNet()), skipPeers: true });
    const html = renderReportHtml(r);
    assert.ok(!html.includes("<img src=x"));
    assert.ok(!/<script/i.test(html));
    assert.match(html, /<h2>8\. Token wrapper<\/h2>/);
  });
});
