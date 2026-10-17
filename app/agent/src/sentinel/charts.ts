/** Server-side inline SVG charts for the report (FR-12, PRD §12.2). Pure functions of the stored snapshot. */
import type { MarketSnapshot } from "./types.js";

interface Pt {
  d: string;
  v: number;
}
const esc = (s: string) => s.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");

function chart(title: string, series: { label: string; color: string; pts: Pt[] }[], fmt: (v: number) => string, note: string): string {
  const live = series.filter((s) => s.pts.length > 1);
  if (!live.length) return `<div class="mute">${esc(title)}: not enough price history.</div>`;
  const W = 700, H = 190, P = 30;
  const all = live.flatMap((s) => s.pts.map((p) => p.v));
  const mn = Math.min(...all), mx = Math.max(...all);
  const y = (v: number) => H - P - ((v - mn) / (mx - mn || 1)) * (H - 2 * P);
  const lines = live.map((s) => `<polyline fill="none" stroke="${s.color}" stroke-width="1.8" points="${s.pts.map((p, i) => `${(P + (i / (s.pts.length - 1)) * (W - 2 * P)).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ")}"/>`).join("");
  const first = live[0]!.pts[0]!.d, last = live[0]!.pts.at(-1)!.d;
  return `<figure style="margin:8px 0"><svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="${esc(title)}"><text x="${P}" y="14" font-size="11" fill="currentColor">${esc(title)} — ${live.map((s) => `<tspan fill="${s.color}">${esc(s.label)}</tspan>`).join(" · ")}</text>${lines}<text x="${P}" y="${H - 8}" font-size="10" fill="currentColor" opacity=".7">${first} → ${last} · min ${esc(fmt(mn))} · max ${esc(fmt(mx))}</text></svg><figcaption class="mute" style="font-size:12px">${esc(note)}</figcaption></figure>`;
}

const pctFmt = (v: number) => `${(v * 100).toFixed(1)}%`;

function seriesOf(s: MarketSnapshot, key: string): Pt[] {
  return (s.metrics.find((m) => m.key === key)?.series ?? []).map((p) => ({ d: p.date, v: p.value }));
}

export function rollingVol(pts: Pt[], win = 30): Pt[] {
  const r = pts.slice(1).map((p, i) => ({ d: p.d, v: p.v / pts[i]!.v - 1 }));
  const out: Pt[] = [];
  for (let i = win; i <= r.length; i++) {
    const w = r.slice(i - win, i).map((x) => x.v);
    const m = w.reduce((a, b) => a + b, 0) / win;
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / (win - 1));
    out.push({ d: r[i - 1]!.d, v: sd * Math.sqrt(252) });
  }
  return out;
}

export function drawdownSeries(pts: Pt[]): Pt[] {
  let peak = -Infinity;
  return pts.map((p) => ((peak = Math.max(peak, p.v)), { d: p.d, v: p.v / peak - 1 }));
}

export function reportCharts(s: MarketSnapshot): string {
  const px = seriesOf(s, "price_last");
  const spy = s.underlying === "SPY" ? [] : seriesOf(s, "spy_price");
  const rebase = (pts: Pt[]) => (pts.length ? pts.map((p) => ({ d: p.d, v: (p.v / pts[0]!.v) * 100 })) : pts);
  return [
    chart("Price rebased to 100", [{ label: s.underlying, color: "#2563eb", pts: rebase(px) }, { label: "SPY", color: "#d97706", pts: rebase(spy) }], (v) => v.toFixed(0), "Daily closes from Yahoo Finance (unofficial, delayed)."),
    chart("Rolling 30-day annualised volatility", [{ label: s.underlying, color: "#7c3aed", pts: rollingVol(px) }], pctFmt, "Standard deviation of daily returns × √252 over a 30-session window."),
    chart("Drawdown from running peak", [{ label: s.underlying, color: "#dc2626", pts: drawdownSeries(px) }], pctFmt, "Close ÷ highest close so far − 1 over the retained history."),
  ].join("");
}
