import { CHAIN_IDS } from "./chains.js";
import { z } from "zod";

// ── Shared enums ─────────────────────────────────────────────────────────────
export const ASSESSMENT_STATUSES = ["INSUFFICIENT_DATA", "NEEDS_REVIEW", "CONDITIONAL_PASS", "DO_NOT_PROCEED"] as const;
export type AssessmentStatus = (typeof ASSESSMENT_STATUSES)[number];

export const EVIDENCE_CLASSES = [
  "USER_SUPPLIED", "DOCUMENT_EXTRACTED", "EXTERNALLY_SOURCED", "ON_CHAIN_OBSERVED", "CALCULATED",
  "INDEPENDENTLY_VERIFIED", "UNVERIFIED", "CONFLICTING", "MISSING",
] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

export type Severity = "low" | "medium" | "high" | "critical";

// ── Supported underlying universe ────────────────────────────────────────────
export const CORE_SYMBOLS = ["AAPL", "GOOGL", "NVDA", "META", "TSLA", "AMZN", "NFLX", "MSFT", "QQQ", "SPY"] as const;
export type Symbol = string;
export interface AssetInfo {
  name: string;
  kind: "stock" | "etf";
  cik: number | null;
}

/** CIKs verified against SEC submissions. ETFs file no company facts. */
export const UNIVERSE: Record<string, AssetInfo> = {
  AAPL: { name: "Apple Inc.", kind: "stock", cik: 320193 },
  GOOGL: { name: "Alphabet Inc. (Class A)", kind: "stock", cik: 1652044 },
  NVDA: { name: "NVIDIA Corporation", kind: "stock", cik: 1045810 },
  META: { name: "Meta Platforms, Inc.", kind: "stock", cik: 1326801 },
  TSLA: { name: "Tesla, Inc.", kind: "stock", cik: 1318605 },
  AMZN: { name: "Amazon.com, Inc.", kind: "stock", cik: 1018724 },
  NFLX: { name: "Netflix, Inc.", kind: "stock", cik: 1065280 },
  MSFT: { name: "Microsoft Corporation", kind: "stock", cik: 789019 },
  QQQ: { name: "Invesco QQQ Trust", kind: "etf", cik: null },
  SPY: { name: "SPDR S&P 500 ETF Trust", kind: "etf", cik: null },
};

/** Supported underlyings: the core ten plus anything registered at start-up. */
export const SYMBOLS: string[] = [...CORE_SYMBOLS];
export const isSymbol = (s: unknown): s is string => typeof s === "string" && Object.prototype.hasOwnProperty.call(UNIVERSE, s);

/**
 * Extensibility registry (PRD §15). Registers an additional stock or ETF.
 * Core symbols cannot be overridden. A stock needs its SEC CIK (so fundamentals
 * come from EDGAR); an ETF needs none. Returns an error string, never throws.
 */
export function registerAsset(ticker: string, info: AssetInfo): string | null {
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/u.test(ticker)) return `"${ticker}" is not a valid ticker`;
  if ((CORE_SYMBOLS as readonly string[]).includes(ticker)) return `"${ticker}" is a core symbol and cannot be overridden`;
  if (info.kind !== "stock" && info.kind !== "etf") return `"${ticker}": kind must be "stock" or "etf"`;
  if (!info.name || info.name.length > 80) return `"${ticker}": name is required (max 80 chars)`;
  if (info.kind === "stock" && !(Number.isInteger(info.cik) && info.cik! > 0)) return `"${ticker}": a stock needs its SEC CIK`;
  if (info.kind === "etf" && info.cik !== null) return `"${ticker}": ETFs file no company facts; cik must be null`;
  UNIVERSE[ticker] = info;
  if (!SYMBOLS.includes(ticker)) SYMBOLS.push(ticker);
  return null;
}

/** SENTINEL_EXTRA_ASSETS_JSON='{"AMD":{"name":"Advanced Micro Devices","kind":"stock","cik":2488}}' */
export function loadExtraAssets(env: NodeJS.ProcessEnv = process.env): string[] {
  if (!env.SENTINEL_EXTRA_ASSETS_JSON) return [];
  try {
    const j = JSON.parse(env.SENTINEL_EXTRA_ASSETS_JSON) as Record<string, AssetInfo>;
    return Object.entries(j).flatMap(([t, info]) => registerAsset(t.toUpperCase(), { name: info.name, kind: info.kind, cik: info.cik ?? null }) ?? []);
  } catch (e) {
    return [`SENTINEL_EXTRA_ASSETS_JSON is not valid JSON: ${e instanceof Error ? e.message : String(e)}`];
  }
}
for (const err of loadExtraAssets()) console.warn(`[sentinel] extra assets: ${err}`);

// ── Dossier: a tokenized stock / ETF on BNB Chain ────────────────────────────
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/u, "must be a 0x… EVM address");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

export const TokenSchema = z
  .object({
    chain: z.enum(CHAIN_IDS).default("bsc"),
    contract_address: address,
    /** Sponsor/issuer claims, cross-checked against the chain. */
    claimed_symbol: z.string().max(24).optional(),
    claimed_name: z.string().max(120).optional(),
    claimed_decimals: z.number().int().min(0).max(36).optional(),
    issuer: z.string().max(160).optional(),
    /** Tokens that represent one underlying share (1 = 1:1). */
    tokens_per_share: z.number().positive().default(1),
    /** Optional Chainlink-style AggregatorV3 feed for the token/USD price, same chain. */
    price_feed: address.optional(),
  })
  .strict();
export type Token = z.infer<typeof TokenSchema>;

export const DOCUMENT_KINDS = ["issuer_terms", "custody_attestation", "audit_report", "reserve_report", "legal_opinion", "other"] as const;

export const ExtractedClaimSchema = z
  .object({
    field: z.string().min(1).max(60),
    value: z.number().finite(),
    location: z.string().max(200).optional(),
    method: z.enum(["structured", "text_pattern", "manual_correction"]).optional(),
  })
  .strict();
export type ExtractedClaim = z.infer<typeof ExtractedClaimSchema>;

export const DocumentSchema = z
  .object({
    doc_id: z.string().min(1).max(60),
    title: z.string().max(200),
    kind: z.enum(DOCUMENT_KINDS),
    /** Untrusted data: scanned and pattern-mined, never executed and never sent to a model. */
    text: z.string().max(400_000).optional(),
    extracted: z.array(ExtractedClaimSchema).max(200).optional(),
    extraction_quality: z.number().min(0).max(1).optional(),
    readable: z.boolean().optional(),
    document_date: date.optional(),
    /** SHA-256 of the uploaded file bytes (provenance). */
    sha256: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
    /** Extraction method and version, e.g. "unpdf-text@1" or "ocr:tesseract@5". */
    extractor: z.string().max(60).optional(),
    original_filename: z.string().max(200).optional(),
  })
  .strict();
export type DossierDocument = z.infer<typeof DocumentSchema>;

export const ClaimsSchema = z
  .object({
    custodian: z.string().max(160).optional(),
    backing: z.enum(["full_1to1", "partial", "synthetic", "unknown"]).optional(),
    /** Underlying shares the issuer says it holds against the token supply. */
    shares_held_in_custody: z.number().nonnegative().optional(),
    redemption: z
      .object({
        available: z.boolean(),
        min_size_usd: z.number().nonnegative().optional(),
        fee_bps: z.number().min(0).max(10_000).optional(),
        settlement_days: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
    kyc_required: z.boolean().optional(),
    transfer_restrictions: z.boolean().optional(),
    dividends: z.enum(["accumulating", "distributed", "none", "unknown"]).optional(),
    custody_doc_id: z.string().optional(),
    terms_doc_id: z.string().optional(),
    audit_doc_id: z.string().optional(),
    legal_opinion_doc_id: z.string().optional(),
    proof_of_reserves_url: z.string().url().max(300).optional(),
  })
  .strict();
export type Claims = z.infer<typeof ClaimsSchema>;

export const ScenarioConfigSchema = z
  .object({
    market_shock_pct: z.array(z.number().min(0).max(90)).max(4).optional(),
    token_discount_pct: z.array(z.number().min(0).max(90)).max(4).optional(),
    multiple_compression_pct: z.number().min(0).max(90).optional(),
    eps_shock_pct: z.number().min(0).max(90).optional(),
  })
  .strict();
export type ScenarioConfig = z.infer<typeof ScenarioConfigSchema>;

export const DossierSchema = z
  .object({
    asset_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u, "letters, digits, _ or -").optional(),
    asset_type: z.literal("tokenized_equity").default("tokenized_equity"),
    underlying: z.string().refine(isSymbol, { message: "not a supported underlying (see GET /services)" }),
    token: TokenSchema.optional(),
    claims: ClaimsSchema.optional(),
    position: z.object({ tokens: z.number().positive(), cost_basis_usd: z.number().nonnegative().optional() }).strict().optional(),
    documents: z.array(DocumentSchema).max(50).default([]),
    /** Attestations that a claim was independently verified, with a reference. */
    independent_verifications: z
      .array(z.object({ claim: z.enum(["custody", "backing", "audit", "legal", "redemption", "contract"]), verifier: z.string().max(160), reference: z.string().max(200), verified_at: z.string().max(40) }).strict())
      .max(50)
      .optional(),
    scenario_config: ScenarioConfigSchema.optional(),
    assumptions: z.array(z.string().max(300)).max(20).optional(),
  })
  .strict()
  .transform((d) => ({ ...d, asset_id: d.asset_id ?? `tok-${d.underlying.toLowerCase()}${d.token ? `-${d.token.contract_address.slice(2, 8).toLowerCase()}` : ""}` }));
export type Dossier = z.output<typeof DossierSchema>;

// ── Calculation records ──────────────────────────────────────────────────────
export interface MetricResult {
  id: string;
  group: "underlying_price" | "underlying_fundamentals" | "token";
  label: string;
  formula: string;
  inputs: Record<string, number | string | null>;
  currency: string | null;
  period: string | null;
  methodology_version: string;
  value: number | null;
  unit: "currency" | "ratio" | "x" | "count" | "days";
  status: "OK" | "MISSING" | "INVALID";
  warnings: string[];
  evidence_class: EvidenceClass;
}

// ── Market snapshot ──────────────────────────────────────────────────────────
export type Freshness = "fresh" | "stale" | "unknown";

export interface MarketSource {
  source_id: string;
  name: string;
  url: string | null;
  kind: "live_api" | "on_chain" | "cached";
  retrieved_at: string;
  notes?: string;
}

export interface SeriesPoint {
  date: string;
  value: number;
}

export interface MarketMetric {
  key: string;
  label: string;
  value: number;
  unit: string;
  observation_period: string;
  observed_at: string;
  source_id: string;
  kind: "observation" | "forecast";
  freshness: Freshness;
  series?: SeriesPoint[];
  /** Where a figure came from precisely (SEC filing accession, block number, …). */
  provenance?: { reference: string; detail: string };
}

export interface MarketSnapshot {
  snapshot_id: string;
  underlying: string;
  token_chain: string | null;
  observation_period: string;
  metrics: MarketMetric[];
  sources: MarketSource[];
  observed_at: string;
  data_quality_status: "live" | "partial" | "cached" | "unavailable";
  limitations: string[];
  /** Raw facts used by calculations that are not themselves time series metrics. */
  facts: SnapshotFacts;
}

export interface Bar {
  date: string;
  close: number;
  adj: number;
  volume: number;
}

export interface SnapshotFacts {
  bars: Bar[];
  spy_bars: Bar[];
  dividends: { date: string; amount: number }[];
  currency: string | null;
  fundamentals: FundamentalFacts | null;
  token: TokenFacts | null;
}

export interface FundamentalFacts {
  cik: number;
  entity: string;
  /** Each field: value + provenance. Missing tags are simply absent. */
  items: Record<string, { value: number; period_end: string; basis: "TTM" | "FY" | "instant"; accession: string; form: string; filed: string }>;
  latest_filed: string;
}

export interface TokenFacts {
  chain: string;
  rpc_host: string;
  block_number: number;
  block_time: number;
  has_code: boolean;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  total_supply: number | null;
  owner: string | null;
  owner_is_contract: boolean | null;
  pausable: boolean | null;
  paused: boolean | null;
  implementation: string | null;
  proxy_admin: string | null;
  /** Beacon contract when the token is a beacon proxy. */
  beacon?: string | null;
  /** Function selectors found in the token (and implementation) bytecode: capability signals, not proof of redemption. */
  redemption_signals?: { burn: boolean; burn_from: boolean; redeem: boolean; mint: boolean; scanned: string[] } | null;
  feed: { address: string; description: string | null; decimals: number; answer: number; updated_at: number; round_id: string } | null;
  errors: string[];
}

// ── Evidence & risk ──────────────────────────────────────────────────────────
export interface EvidenceRecord {
  evidence_id: string;
  asset_id: string;
  claim: string;
  source_type: "user_input" | "document" | "api" | "on_chain" | "calculation" | "registry";
  source_reference: string;
  location_reference: string | null;
  observed_value: number | string | boolean | null;
  observed_at: string | null;
  verification_status: EvidenceClass;
  review_notes: string[];
}

export interface Risk {
  risk_id: string;
  scope: "market" | "underlying" | "token";
  category: string;
  description: string;
  severity: Severity;
  supporting_evidence: string[];
  potential_impact: string;
  confidence: "low" | "medium" | "high";
  suggested_follow_up: string;
  invalidation_condition: string | null;
}
