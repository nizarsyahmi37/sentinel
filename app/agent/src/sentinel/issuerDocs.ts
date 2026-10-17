/**
 * Real issuer documents (no fixtures). Fetches public documents straight from
 * the issuers' own sites — fixed, allow-listed hosts only — and runs them
 * through Sentinel's normal document pipeline. The documents are the issuers'
 * own statements: they are evidence of what the issuer CLAIMS, never proof, and
 * no independent verification is attached.
 */
import { type DossierDocument } from "./types.js";
import { ingestDocument } from "./documents.js";
import { KNOWN_TOKENS } from "./knownTokens.js";
import { type FetchLike, defaultFetch } from "./sources.js";

const ONDO_TRUST_URL = "https://docs.ondo.finance/ondo-stocks/trust-and-transparency.md";
const BACKED_LEGAL_URL = "https://assets.backed.fi/legal-documentation";
const ALLOWED_HOSTS = new Set(["docs.ondo.finance", "assets.backed.fi", "cdn.prod.website-files.com"]);
const MAX_PDF = 5 * 1024 * 1024;

const cache = new Map<string, { at: number; v: unknown }>();
/** Documents are cached for 6 h, but only for real network fetches (an injected fetch is never cached). */
async function memo<T>(key: string, enabled: boolean, f: () => Promise<T>): Promise<T> {
  const hit = enabled ? cache.get(key) : undefined;
  if (hit && Date.now() - hit.at < 6 * 3_600_000) return hit.v as T;
  const v = await f();
  if (enabled) cache.set(key, { at: Date.now(), v });
  return v;
}

async function get(f: FetchLike, url: string, bin = false): Promise<{ text: string; buf?: Buffer }> {
  const u = new URL(url);
  if (u.protocol !== "https:" || !ALLOWED_HOSTS.has(u.hostname)) throw new Error(`host not allowed: ${u.hostname}`);
  const res = await f(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; Sentinel/1.0)" }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${u.hostname}`);
  if (bin) {
    const ab = (res as unknown as { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer;
    if (!ab) throw new Error("binary responses are not supported by this fetch implementation");
    const buf = Buffer.from(await ab.call(res));
    if (buf.length > MAX_PDF) throw new Error(`document larger than ${MAX_PDF / 1024 / 1024} MB`);
    return { text: "", buf };
  }
  return { text: await res.text() };
}

export interface FetchedDoc {
  document: DossierDocument;
  source_url: string;
  fetched_at: string;
  summary: Record<string, unknown>;
}

export async function ondoTrustDoc(f: FetchLike = defaultFetch): Promise<FetchedDoc> {
  return memo("ondo", f === defaultFetch, async () => {
    const { text } = await get(f, ONDO_TRUST_URL);
    const r = await ingestDocument({ doc_id: "ondo-trust-transparency", title: "Ondo Stocks — Trust & Transparency (issuer web page)", kind: "other", filename: "ondo-trust-and-transparency.md", text });
    return { document: r.document, source_url: ONDO_TRUST_URL, fetched_at: new Date().toISOString(), summary: r.summary };
  });
}

/** Finds the latest Base Prospectus linked from Backed's legal-documentation page and ingests the PDF. */
export async function backedProspectusDoc(f: FetchLike = defaultFetch): Promise<FetchedDoc> {
  return memo("backed", f === defaultFetch, async () => {
    const page = (await get(f, BACKED_LEGAL_URL)).text;
    const links = [...page.matchAll(/href="(https:\/\/cdn\.prod\.website-files\.com\/[^"]*Base(?:%20| )Prospectus[^"]*\.pdf)"/giu)].map((m) => m[1]!);
    if (!links.length) throw new Error("no Base Prospectus link found on the Backed legal-documentation page");
    const url = links[0]!;
    const { buf } = await get(f, url, true);
    const name = decodeURIComponent(url.split("/").pop() ?? "prospectus.pdf");
    const r = await ingestDocument({ doc_id: "backed-base-prospectus", title: `Backed Assets (JE) Limited — ${name}`, kind: "issuer_terms", filename: "backed-base-prospectus.pdf", content_base64: buf!.toString("base64") });
    return { document: r.document, source_url: url, fetched_at: new Date().toISOString(), summary: r.summary };
  });
}

export type IssuerKey = "ondo" | "xstocks";

/** A real token + the issuer's own published documents. Claims are limited to what those documents themselves state. */
export async function realDocsCase(symbol: string, issuer: IssuerKey, f: FetchLike = defaultFetch) {
  const tok = KNOWN_TOKENS.find((t) => t.underlying === symbol && t.chain === "bsc" && (issuer === "ondo" ? t.issuer.startsWith("Ondo") : t.issuer.startsWith("xStocks")));
  if (!tok) return null;
  const doc = issuer === "ondo" ? await ondoTrustDoc(f) : await backedProspectusDoc(f);
  const claims =
    issuer === "ondo"
      ? { backing: "full_1to1" as const, custodian: "Regulated custodian broker-dealers (names not stated on the cited page); Ankura Trust Company is the stated verification and security agent" }
      : { backing: "full_1to1" as const };
  return {
    dossier: {
      underlying: symbol,
      token: { chain: tok.chain, contract_address: tok.address, claimed_symbol: tok.symbol, issuer: tok.issuer, tokens_per_share: 1 },
      claims,
      documents: [doc.document],
    },
    provenance: {
      document_source: doc.source_url,
      fetched_at: doc.fetched_at,
      note: "The document is the issuer's own public statement. Claims in this dossier repeat what it says and are unverified by any independent party; Sentinel reports them as such.",
      extraction: doc.summary,
    },
  };
}
