/** Human-readable web report (FR-12). Every dynamic string is HTML-escaped. */
import type { SentinelReport } from "./pipeline.js";
import { explorerUrl } from "./chains.js";
import { reportCharts } from "./charts.js";
import type { MetricResult } from "./types.js";

export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

const STATUS_CLASS: Record<string, string> = {
  CONDITIONAL_PASS: "ok",
  NEEDS_REVIEW: "warn",
  INSUFFICIENT_DATA: "mute",
  DO_NOT_PROCEED: "bad",
};


const fmtMetric = (m: MetricResult): string => {
  if (m.status !== "OK" || m.value === null) return `<span class="mute">${esc(m.status)}</span>`;
  if (m.unit === "ratio") return `${(m.value * 100).toFixed(2)}%`;
  if (m.unit === "x") return `${m.value.toFixed(3)}x`;
  if (m.unit === "currency") return `${m.value.toLocaleString("en-US")} USD`;
  if (m.unit === "days") return `${m.value.toFixed(2)} days`;
  return m.value.toLocaleString("en-US");
};

const sev = (s: string) => `<span class="chip sev-${esc(s)}">${esc(s)}</span>`;
const cls = (s: string) => `<span class="chip cls-${esc(s)}">${esc(s.replace(/_/gu, " "))}</span>`;
const list = (items: string[]) => (items.length ? `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>` : `<p class="mute">None.</p>`);

export const REPORT_CSS = `
.sr{--bg:#fff;--fg:#14181f;--mut:#5b6573;--line:#e3e7ee;--card:#f7f9fc;--ok:#0f7b4b;--warn:#a15c00;--bad:#b3261e;--info:#1d4ed8;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--fg);background:var(--bg)}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]) .sr{--bg:#0f1318;--fg:#e8ecf2;--mut:#9aa6b6;--line:#262d38;--card:#161b23;--ok:#4cc38a;--warn:#e0a23b;--bad:#ff7b72;--info:#79a6ff}}
:root[data-theme=dark] .sr{--bg:#0f1318;--fg:#e8ecf2;--mut:#9aa6b6;--line:#262d38;--card:#161b23;--ok:#4cc38a;--warn:#e0a23b;--bad:#ff7b72;--info:#79a6ff}
.sr h1{font-size:22px;margin:0 0 4px}.sr h2{font-size:16px;margin:28px 0 8px;padding-top:12px;border-top:1px solid var(--line)}.sr h3{font-size:14px;margin:16px 0 6px}
.sr table{width:100%;border-collapse:collapse;margin:6px 0 10px;font-size:13px}.sr th,.sr td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}.sr th{color:var(--mut);font-weight:600}
.sr .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.sr .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.sr .card .k{color:var(--mut);font-size:12px}.sr .card .v{font-size:19px;font-weight:650;margin-top:2px}
.sr .badge{display:inline-block;padding:3px 12px;border-radius:999px;font-weight:650;font-size:13px;border:1px solid currentColor}
.sr .ok{color:var(--ok)}.sr .warn{color:var(--warn)}.sr .bad{color:var(--bad)}.sr .mute{color:var(--mut)}
.sr .chip{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;border:1px solid var(--line);background:var(--card);margin-right:4px;white-space:nowrap}
.sr .sev-critical,.sr .sev-high,.sr .cls-CONFLICTING{color:var(--bad);border-color:var(--bad)}.sr .sev-medium,.sr .cls-UNVERIFIED,.sr .cls-MISSING{color:var(--warn);border-color:var(--warn)}.sr .sev-low{color:var(--mut)}
.sr .cls-INDEPENDENTLY_VERIFIED,.sr .cls-EXTERNALLY_SOURCED{color:var(--ok);border-color:var(--ok)}.sr .cls-CALCULATED{color:var(--info);border-color:var(--info)}
.sr .note{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--warn);border-radius:6px;padding:8px 12px;margin:8px 0;font-size:13px}
.sr code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--card);padding:1px 5px;border-radius:4px;word-break:break-all}
.sr .fired{font-weight:650}.sr details{margin:6px 0}.sr summary{cursor:pointer;color:var(--mut)}
.sr .legend span{margin-right:12px;font-size:12px}
@media print{header,nav,footer,.noprint{display:none!important}body{background:#fff!important}.sr{--bg:#fff;--fg:#000;--mut:#444;--line:#bbb;--card:#f3f3f3}.sr h2{break-after:avoid}.sr tr{break-inside:avoid}}
`;


function metricsTable(ms: MetricResult[]): string {
  if (!ms.length) return `<p class="mute">None.</p>`;
  return `<table><tr><th>Metric</th><th>Value</th><th>Basis</th><th>Notes</th></tr>${ms
    .map((m) => `<tr><td>${esc(m.label)}</td><td><b>${fmtMetric(m)}</b></td><td><code>${esc(m.formula)}</code>${m.period ? `<div class="mute">${esc(m.period)}</div>` : ""}</td><td>${m.warnings.map((w) => `<div class="mute">${esc(w)}</div>`).join("")}</td></tr>`)
    .join("")}</table>`;
}

const explorer = explorerUrl;

function riskTable(risks: SentinelReport["risks"]["token"]): string {
  if (!risks.length) return `<p class="mute">No risks identified from the available data. This does not imply absence of risk.</p>`;
  return `<table><tr><th>Risk</th><th>Severity</th><th>Impact / confidence</th><th>Follow-up / invalidation</th></tr>${risks
    .map((x) => `<tr><td><b>${esc(x.category.replace(/_/gu, " "))}</b><div>${esc(x.description)}</div><div class="mute">evidence: ${esc(x.supporting_evidence.join(", ") || "—")}</div></td><td>${sev(x.severity)}</td><td>${esc(x.potential_impact)}<div class="mute">confidence: ${esc(x.confidence)}</div></td><td>${esc(x.suggested_follow_up)}${x.invalidation_condition ? `<div class="mute">invalid if: ${esc(x.invalidation_condition)}</div>` : ""}</td></tr>`)
    .join("")}</table>`;
}

export function renderReportBody(r: SentinelReport): string {
  const a = r.assessment;
  const ex = r.executive_summary;
  const snap = r.market.snapshot;
  const o = r.asset_overview;
  const tf = snap.facts.token;
  const cache = snap.sources.some((s) => s.kind === "cached");
  const money = (n: number | null) => (n === null ? "n/a" : n.toLocaleString("en-US"));
  const byGroup = (g: MetricResult["group"]) => r.asset.metrics.filter((m) => m.group === g);
  const fmtN = (n: number | null | undefined, d = 2) => (n === null || n === undefined ? "n/a" : String(Math.round(n * 10 ** d) / 10 ** d));
  const scen = r.scenarios;
  return `
<div class="sr">
<h1>${esc(o.name)} (${esc(o.underlying)})${o.token ? " — tokenized" : ""}</h1>
<div class="mute">Sentinel report <code>${esc(r.report_id)}</code> v${esc(r.report_version)} · methodology <code>${esc(r.methodology_version)}</code> · ${esc(r.generated_at)}</div>
<p><span class="badge ${STATUS_CLASS[a.status] ?? "mute"}">${esc(a.status.replace(/_/gu, " "))}</span>
<span class="mute"> determined by ${a.determining_rules.map((x) => `<code>${esc(x)}</code>`).join(" ")}</span></p>
${cache ? `<div class="note"><b>Cached data in use.</b> At least one source could not be reached live; a labelled cached copy was used and is marked stale.</div>` : ""}
${snap.sources.some((s) => s.source_id === "what_if") ? `<div class="note"><b>WHAT-IF values in use.</b> One or more metrics were replaced for testing and are not observations.</div>` : ""}

<h2>1. Executive summary</h2>
<p>${esc(ex.headline)}</p>
<div class="grid">${ex.key_figures.map((k) => `<div class="card"><div class="k">${esc(k.label)}</div><div class="v">${esc(k.value)}</div><div class="k">${esc(k.basis)}</div></div>`).join("")}</div>
${ex.top_risks.length ? `<h3>Top risks</h3>${list(ex.top_risks.map(esc))}` : ""}
<div class="note">${esc(r.disclaimer)}</div>

<h2>2. Asset overview</h2>
<table><tr><th>Underlying</th><td>${esc(o.name)} (<code>${esc(o.underlying)}</code>, ${esc(o.kind)})</td><th>Currency</th><td>${esc(o.currency ?? "n/a")}</td></tr>
${o.token ? `<tr><th>Token</th><td><a href="${esc(explorer(o.token.chain, "address", o.token.contract_address))}" rel="noreferrer noopener" target="_blank"><code>${esc(o.token.contract_address)}</code></a> on ${esc(o.token.chain)}</td><th>Issuer (claimed)</th><td>${esc(o.token.issuer ?? "not stated")}</td></tr>
<tr><th>On-chain name / symbol</th><td>${esc(o.token.onchain?.name ?? "n/a")} / ${esc(o.token.onchain?.symbol ?? "n/a")}</td><th>Tokens per share (claimed)</th><td>${esc(o.token.tokens_per_share)}</td></tr>
<tr><th>Decimals / supply (on-chain)</th><td>${esc(o.token.onchain?.decimals ?? "n/a")} / ${esc(money(o.token.onchain?.total_supply ?? null))}</td><th>Block</th><td>${esc(o.token.onchain?.block_number ?? "n/a")}</td></tr>` : `<tr><th>Token</th><td colspan="3" class="warn">No token contract supplied — only the underlying was assessed.</td></tr>`}
${o.position ? `<tr><th>Position</th><td>${esc(o.position.tokens)} tokens</td><th>Cost basis</th><td>${o.position.cost_basis_usd === null ? "n/a" : esc(o.position.cost_basis_usd)} USD</td></tr>` : ""}</table>
<p class="mute">${esc(o.exchange_note)} ${esc(o.claims_note)}</p>

<h2>3. Market conditions</h2>
<p>Market regime: <b>${esc(r.market.analysis.attractiveness.label)}</b>. <span class="mute">${esc(r.market.analysis.attractiveness.rule)}</span></p>
${list(r.market.analysis.attractiveness.drivers.map((d) => `<b>${esc(d.driver)}</b> (${esc(d.direction)}): ${esc(d.basis)}`))}
<h3>Market thesis invalidation conditions</h3>${list(r.market_thesis_invalidation.map((m) => esc(m.condition)))}

<h2>4. Market data and timestamps</h2>
<p>Snapshot <code>${esc(snap.snapshot_id)}</code> · quality <b>${esc(snap.data_quality_status)}</b> · as of ${esc(snap.observation_period)}</p>
<table><tr><th>Metric</th><th>Value</th><th>Period</th><th>Observed</th><th>Freshness</th><th>Source</th></tr>${snap.metrics
    .map((m) => {
      const s = snap.sources.find((x) => x.source_id === m.source_id);
      const src = m.provenance?.reference.startsWith("http") ? `<a href="${esc(m.provenance.reference)}" rel="noreferrer noopener" target="_blank">${esc(m.provenance.detail)}</a>` : s?.url ? `<a href="${esc(s.url)}" rel="noreferrer noopener" target="_blank">${esc(s.name)}</a>` : esc(s?.name ?? m.source_id);
      return `<tr><td>${esc(m.label)}</td><td><b>${esc(m.value)}</b> ${esc(m.unit)}</td><td>${esc(m.observation_period)}</td><td>${esc(m.observed_at.slice(0, 10))}</td><td>${m.freshness === "stale" ? `<span class="chip sev-medium">stale</span>` : esc(m.freshness)}</td><td>${src}${m.provenance && !m.provenance.reference.startsWith("http") ? ` <span class="mute">(${esc(m.provenance.detail)})</span>` : ""}</td></tr>`;
    })
    .join("")}</table>
${snap.limitations.length ? `<h3>Data limitations</h3>${list(snap.limitations.map(esc))}` : ""}

<h2>5. Underlying: price, risk and fundamentals</h2>
<h3>Charts</h3>${reportCharts(snap)}
<h3>Price and risk statistics</h3>${metricsTable(byGroup("underlying_price"))}
<h3>Fundamentals (SEC filings)</h3>${metricsTable(byGroup("underlying_fundamentals"))}
${r.etf_lookthrough ? `<h3>ETF look-through</h3>${r.etf_lookthrough.status === "ok" ? `<p>${esc(r.etf_lookthrough.count)} holdings as of ${esc(r.etf_lookthrough.as_of ?? "n/a")} (issuer file); top 10 = <b>${((r.etf_lookthrough.top10_weight ?? 0) * 100).toFixed(1)}%</b> of the fund.</p><table><tr><th>Ticker</th><th>Name</th><th>Weight</th></tr>${r.etf_lookthrough.top.map((h) => `<tr><td><code>${esc(h.ticker)}</code></td><td>${esc(h.name)}</td><td>${(h.weight * 100).toFixed(2)}%</td></tr>`).join("")}</table><p class="mute">Source: <a href="${esc(r.etf_lookthrough.source_url ?? "")}" rel="noreferrer noopener" target="_blank">issuer holdings file</a>.</p>` : `<div class="note">Look-through unavailable: ${esc(r.etf_lookthrough.reason ?? "unknown")}. Holdings are not approximated.</div>`}` : ""}

<h2>6. Peer / comparable market analysis</h2>
<p>${esc(r.peers.comparability_note)}</p>
${r.peers.excluded.length ? list(r.peers.excluded.map((e) => `<code>${esc(e.symbol)}</code> excluded — ${esc(e.reason)}`)) : ""}
<table><tr><th>Metric</th><th>${esc(r.peers.subject)}</th><th>Peer median</th><th>vs median</th><th>Percentile among peers</th><th>Same-industry median (n)</th><th>vs industry</th><th>Peers</th></tr>${r.peers.comparisons
    .map((c) => `<tr><td>${esc(c.label)}</td><td><b>${c.subject === null ? "n/a" : esc(c.subject)}</b></td><td>${c.peer_median === null ? "—" : esc(c.peer_median)}</td><td>${c.vs_median === null ? "—" : (c.vs_median * 100).toFixed(0) + "%"}</td><td>${c.percentile === null ? "—" : Math.round(c.percentile * 100) + "th"}</td><td>${c.industry_median === null ? "—" : `${esc(c.industry_median)} (${c.industry_count})`}</td><td>${c.vs_industry_median === null ? "—" : (c.vs_industry_median * 100).toFixed(0) + "%"}</td><td class="mute">${esc(c.peer_count)}${c.note ? ` · ${esc(c.note)}` : ""}</td></tr>`)
    .join("")}</table>
<p>Relative strength (12m): vs SPY <b>${r.peers.relative_strength.vs_spy === null ? "n/a" : (r.peers.relative_strength.vs_spy * 100).toFixed(1) + " pp"}</b> · vs QQQ <b>${r.peers.relative_strength.vs_qqq === null ? "n/a" : (r.peers.relative_strength.vs_qqq * 100).toFixed(1) + " pp"}</b> <span class="mute">(${esc(r.peers.relative_strength.basis)})</span></p>
<p class="small">Official classification (${esc(r.peers.classification.basis)}): subject <b>${esc(r.peers.classification.subject.sic ?? "n/a")}</b> ${esc(r.peers.classification.subject.description ?? "")} — peers in the same SEC industry: <b>${r.peers.classification.same}</b>, different: <b>${r.peers.classification.different}</b>, unknown: ${r.peers.classification.unknown}.</p>
<details><summary>Peer values</summary><table><tr><th>Symbol</th>${r.peers.comparisons.map((c) => `<th>${esc(c.label)}</th>`).join("")}</tr>${r.peers.rows
    .map((row) => `<tr><td><code>${esc(row.symbol)}</code> <span class="mute">${esc(row.kind)}</span></td>${r.peers.comparisons.map((c) => `<td>${row.status === "ok" && row.values[c.metric] !== null && row.values[c.metric] !== undefined ? esc(row.values[c.metric]) : '<span class="mute">n/a</span>'}</td>`).join("")}</tr>`)
    .join("")}</table></details>

<h2>7. Valuation context <span class="chip">context only — not a price target</span></h2>
<p>${esc(r.peers.valuation_context.summary)}</p>
${r.peers.valuation_context.items.length && r.peers.valuation_context.available ? `<table><tr><th>Multiple</th><th>${esc(r.peers.subject)}</th><th>Peer median</th><th>Reading</th></tr>${r.peers.valuation_context.items.map((i) => `<tr><td>${esc(i.metric)}</td><td>${i.subject === null ? "n/a" : esc(i.subject)}</td><td>${i.peer_median === null ? "—" : esc(i.peer_median)}</td><td>${esc(i.reading)}${i.vs_median === null ? "" : ` (${i.vs_median >= 0 ? "+" : ""}${(i.vs_median * 100).toFixed(0)}%)`}</td></tr>`).join("")}</table>` : ""}
${r.peers.valuation_context.token_vs_underlying ? `<p>Token vs underlying: ${esc(r.peers.valuation_context.token_vs_underlying.reading)}.</p>` : ""}
${list(r.peers.valuation_context.caveats.map(esc))}

<h2>8. Token wrapper</h2>
${o.token ? `<p>Everything in this section marked <i>on-chain</i> was returned by the contract itself at block ${esc(tf?.block_number ?? "n/a")}; custody, backing and redemption are issuer claims unless the evidence register says otherwise.</p>
${tf ? `<table><tr><th>Code present</th><td>${tf.has_code ? "yes" : '<b class="bad">NO</b>'}</td><th>Name / symbol / decimals</th><td>${esc(tf.name ?? "n/a")} / ${esc(tf.symbol ?? "n/a")} / ${esc(tf.decimals ?? "n/a")}</td></tr>
<tr><th>Owner</th><td>${tf.owner ? `<a href="${esc(explorer(tf.chain, "address", tf.owner))}" target="_blank" rel="noreferrer noopener"><code>${esc(tf.owner)}</code></a> (${tf.owner_is_contract ? "contract" : "externally owned account"})` : "none exposed"}</td><th>Pausable / paused</th><td>${tf.pausable ? "yes" : "no"} / ${tf.paused === null ? "n/a" : tf.paused ? '<b class="bad">PAUSED</b>' : "no"}</td></tr>
<tr><th>Upgradeable proxy</th><td>${tf.implementation ? `<code>${esc(tf.implementation)}</code>${tf.proxy_admin ? ` (admin <code>${esc(tf.proxy_admin)}</code>)` : ""}` : "not detected (EIP-1967)"}</td><th>Price feed</th><td>${tf.feed ? `${esc(tf.feed.description ?? tf.feed.address)}: <b>${esc(tf.feed.answer)}</b> (updated ${esc(new Date(tf.feed.updated_at * 1000).toISOString())})` : "none supplied / unreadable"}</td></tr></table>` : `<div class="note">The token could not be read from the chain. ${esc(snap.limitations.join(" "))}</div>`}
<h3>Token metrics</h3>${metricsTable(byGroup("token"))}` : `<div class="note">No token contract was supplied. Provide a BNB Chain contract address to assess the wrapper.</div>`}

<h2>9. Scenario analysis <span class="chip">hypothetical — not forecasts</span></h2>
<table><tr><th>Scenario</th><th>Underlying price</th><th>Change</th><th>Value / token</th><th>Position value</th><th>Changes / held constant</th></tr>${scen
    .map((s) =>
      s.status !== "computed"
        ? `<tr><td>${esc(s.label)} <span class="chip">L${s.level}</span></td><td colspan="5" class="mute">Not computable: ${esc(s.reason)}</td></tr>`
        : `<tr><td>${esc(s.label)} <span class="chip">L${s.level}</span></td><td>${fmtN(s.metrics.underlying_price, 2)}</td><td>${s.metrics.underlying_change === null || s.metrics.underlying_change === undefined ? "n/a" : (s.metrics.underlying_change * 100).toFixed(1) + "%"}</td><td>${fmtN(s.metrics.token_value_per_token, 4)}</td><td>${fmtN(s.metrics.position_value_usd, 2)}</td><td><div>${s.changes.map((c) => `${esc(c.variable)}: ${esc(c.from)} → ${esc(c.to)}`).join("; ")}</div><details><summary>assumptions &amp; held constant</summary>${list(s.assumptions.map(esc))}<div class="mute">Held constant: ${esc(s.held_constant.join(", "))}</div></details></td></tr>`,
    )
    .join("")}</table>

<h2>10. Integrated risk register</h2>
<h3>Token wrapper risks</h3>${riskTable(r.risks.token)}
<h3>Underlying risks</h3>${riskTable(r.risks.underlying)}
<h3>Market risks</h3>${riskTable(r.risks.market)}
<h3>Risk coverage</h3>
<p class="mute">Categories evaluated, and those that could not be assessed (absence of a finding is not absence of risk).</p>
<table><tr><th>Category</th><th>Status</th><th>Basis / reason</th></tr>${[
      ...r.risk_coverage.assessed.map((x) => `<tr><td>${esc(x.scope)} · ${esc(x.category.replace(/_/gu, " "))}</td><td>assessed</td><td class="mute">${esc(x.basis)}</td></tr>`),
      ...r.risk_coverage.not_assessed.map((x) => `<tr><td>${esc(x.scope)} · ${esc(x.category.replace(/_/gu, " "))}</td><td class="warn">not assessed</td><td class="mute">${esc(x.reason)}</td></tr>`),
    ].join("")}</table>

<h2>11. Evidence register</h2>
<p>Evidence quality: <b>${esc(r.evidence.status)}</b> · ${r.evidence.records.length} records · ${r.evidence.conflicts.length} conflict(s) · ${r.evidence.injection_findings.length} injection-like finding(s)</p>
${r.evidence.conflicts.length ? `<h3>Conflicts</h3>${list(r.evidence.conflicts.map((c) => `<b>${esc(c.field)}</b> ${c.material ? sev("high") : sev("medium")} — ${esc(c.values.map((v) => `${v.source} = ${v.value}`).join(" vs "))}${c.max_difference_pct === null ? "" : ` (${esc(c.max_difference_pct)}% apart)`}`))}` : ""}
${r.evidence.injection_findings.length ? `<h3>Untrusted-content findings</h3>${list(r.evidence.injection_findings.map((f) => `<code>${esc(f.doc_id)}</code> ${esc(f.location)} · ${esc(f.pattern)} — “${esc(f.excerpt)}”<div class="mute">${esc(f.handling)}</div>`))}` : ""}
<details open><summary>Evidence records</summary><table><tr><th>Claim</th><th>Status</th><th>Value</th><th>Source</th><th>Notes</th></tr>${r.evidence.records
    .filter((e) => e.verification_status !== "CALCULATED")
    .map((e) => `<tr><td>${esc(e.claim)}</td><td>${cls(e.verification_status)}</td><td>${esc(e.observed_value ?? "—")}</td><td>${esc(e.source_reference.slice(0, 90))}${e.location_reference ? ` <span class="mute">(${esc(e.location_reference)})</span>` : ""}</td><td class="mute">${esc(e.review_notes.join(" "))}</td></tr>`)
    .join("")}</table></details>

<h2>12. Investment thesis and counterarguments</h2>
<p class="mute">Narrative source: <b>${esc(r.thesis.narrative_source)}</b> — ${esc(r.thesis.validation_notes.join(" "))}</p>
<p>${esc(r.thesis.thesis_summary)}</p>
<h3>Supporting factors</h3>${list(r.thesis.supporting_factors.map((f) => `${esc(f.text)} ${f.basis.map((b) => `<span class="chip">${esc(b.replace(/_/gu, " "))}</span>`).join("")}`))}
<h3>Counterarguments</h3>${list(r.thesis.counterarguments.map((f) => `${esc(f.text)} ${f.basis.map((b) => `<span class="chip">${esc(b.replace(/_/gu, " "))}</span>`).join("")}`))}
<h3>Assessment dimensions</h3>
<table>${(["market_attractiveness", "asset_fundamentals", "token_structure", "evidence_quality", "risk_exposure"] as const).map((k) => `<tr><th>${esc(k.replace(/_/gu, " "))}</th><td><b>${esc(a.dimensions[k].label)}</b></td><td class="mute">${esc(a.dimensions[k].drivers.join(" · "))}</td></tr>`).join("")}</table>
<h3>Assumptions that must hold</h3>${list(a.dimensions.investment_conditions.assumptions_to_hold.map(esc))}
<h3>Rules evaluated</h3>
<table><tr><th>Rule</th><th>Outcome</th><th>Fired</th><th>Description / detail</th></tr>${a.rules.map((x) => `<tr class="${x.fired ? "fired" : "mute"}"><td><code>${esc(x.rule_id)}</code></td><td>${esc(x.outcome)}</td><td>${x.fired ? "yes" : "no"}</td><td>${esc(x.description)}${x.detail ? `<div>${esc(x.detail)}</div>` : ""}</td></tr>`).join("")}</table>

<h2>13. Missing-information checklist</h2>
${list(r.missing_information_checklist.map((c) => `${sev(c.severity)} ${esc(c.item)} <span class="mute">— ${esc(c.required_for)}</span>`))}

<h2>14. Invalidation conditions and monitoring</h2>
${list(r.invalidation_conditions.map((c) => `${esc(c.condition)} <span class="mute">— ${esc(c.basis)}</span>`))}
<h3>Required diligence</h3>${list(a.dimensions.investment_conditions.required_diligence.map(esc))}
<h3>Monitoring thresholds</h3>${list(r.monitoring.thresholds.map((t) => `<b>${esc(t.label)}</b> — ${esc(t.note)}`))}<p class="mute">${esc(r.monitoring.note)}</p>

<h2>15. Methodology and limitations</h2>
${list(r.methodology.notes.map(esc))}
<h3>Limitations</h3>${list(r.limitations.map(esc))}
<div class="legend"><b>Legend:</b> ${Object.entries(r.legend).map(([k, v]) => `<span><span class="chip">${esc(k)}</span>${esc(v)}</span>`).join("")}</div>

<h2>16. Review status</h2><p>${esc(r.review_status)}</p>
<h2>17. Report version</h2>
<table><tr><th>Report</th><td><code>${esc(r.report_id)}</code> v${esc(r.report_version)}</td><th>Dossier version</th><td><code>${esc(r.inputs.dossier_version)}</code></td></tr>
<tr><th>Market snapshot</th><td><code>${esc(r.inputs.market_snapshot_id)}</code></td><th>Previous</th><td>${esc(r.inputs.previous_analysis_id ?? "—")}</td></tr>
<tr><th>Calculation hash</th><td colspan="3"><code>${esc(r.hashes.calculation_hash)}</code></td></tr>
<tr><th>Report hash</th><td colspan="3"><code>${esc(r.hashes.report_hash)}</code></td></tr></table>
<p class="mute">A hash shows whether this report version changed; it does not prove the underlying facts are correct.</p>
</div>`;
}

export function renderReportHtml(r: SentinelReport): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${esc(r.asset_overview.underlying)} — Sentinel report</title><style>:root{color-scheme:light dark}body{margin:0;padding:24px 16px;background:Canvas;color:CanvasText}main{max-width:1000px;margin:0 auto;padding:8px 16px;border-radius:10px}${REPORT_CSS}</style></head><body><main>${renderReportBody(r)}</main></body></html>`;
}
