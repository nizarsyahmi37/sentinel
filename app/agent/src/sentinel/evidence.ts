/**
 * Evidence & verification engine (FR-04, FR-05, PRD §9, §14.2).
 *
 * - On-chain facts and issuer claims are kept apart: what the chain says is
 *   ON_CHAIN_OBSERVED; what the issuer says is USER_SUPPLIED/UNVERIFIED until
 *   an explicit, referenced attestation exists (INDEPENDENTLY_VERIFIED).
 * - Document text is UNTRUSTED. It is scanned and mined with fixed patterns,
 *   never executed, never sent to a model, and cannot change a status.
 * - Document agreement is not verification.
 */
import type { Thresholds } from "./config.js";
import type {
  Dossier, DossierDocument, EvidenceClass, EvidenceRecord, ExtractedClaim, MarketSnapshot, MetricResult, Severity,
} from "./types.js";
import { round, shortId } from "./util.js";

// ── Text mining ──────────────────────────────────────────────────────────────
const FIELD_PATTERNS: [string, RegExp][] = [
  ["token_supply", /(?:tokens?|units)\s+(?:outstanding|in\s+circulation)|circulating\s+supply|total\s+(?:token\s+)?supply/i],
  ["shares_in_custody", /shares?\s+(?:held\s+)?in\s+custody|underlying\s+shares\s+held|shares\s+held\s+by\s+(?:the\s+)?custodian/i],
  ["tokens_per_share", /tokens?\s+per\s+(?:underlying\s+)?share/i],
];
const SUFFIX: Record<string, number> = { k: 1e3, m: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 };

export function extractFromText(text: string): ExtractedClaim[] {
  const out: ExtractedClaim[] = [];
  let page = 1;
  text.split(/\r?\n/u).forEach((line, i) => {
    const pm = /^\s*\[page\s+(\d+)\]\s*$/iu.exec(line);
    if (pm) {
      page = Number(pm[1]);
      return;
    }
    for (const [field, re] of FIELD_PATTERNS) {
      const m = new RegExp(`(?:${re.source})[^\\d\\n]{0,40}?(-?\\d[\\d,]*(?:\\.\\d+)?)\\s*(k|mn|m|million|bn|b|billion)?\\b`, "iu").exec(line);
      if (!m) continue;
      let v = Number((m[1] as string).replace(/,/gu, ""));
      if (!Number.isFinite(v)) continue;
      if (m[2]) v *= SUFFIX[(m[2] as string).toLowerCase()] ?? 1;
      out.push({ field, value: v, location: `page ${page}, line ${i + 1}`, method: "text_pattern" });
      break;
    }
  });
  return out;
}

// ── Prompt-injection scan ────────────────────────────────────────────────────
/**
 * Patterns that target an automated reader. They require directive wording (a verb aimed at the
 * reader/agent), because real issuer documents are full of ordinary crypto/legal prose
 * ("private key", "execute a transaction", "transfer of funds") that is not an instruction.
 * A match preceded by a negation ("do not share your private key") is ignored.
 */
const INJECTION_PATTERNS: [string, RegExp][] = [
  ["instruction_override", /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|all)\b[^.\n]{0,40}\b(instructions?|rules?|prompts?)\b/i],
  ["role_hijack", /\b(you are now|new instructions?|system prompt|developer mode)\b|\bact as (?:an? |the )?(?:system|assistant|ai\b|language model|administrator|auditor who)/i],
  ["status_manipulation", /\b(mark|set|label|treat)\b[^.\n]{0,60}\b(as|to)\b[^.\n]{0,30}\b(verified|approved|conditional[_ ]pass|pass(?:ed)?)\b/i],
  ["payment_redirect", /\b(send|transfer|pay|refund|release|redirect)\b[^.\n]{0,60}\b(to|into)\b[^.\n]{0,25}(0x[a-fA-F0-9]{6,}|\b(?:this|the following|my|our|new)\s+(?:wallet|address|account))/i],
  ["secret_exfiltration", /\b(send|share|reveal|disclose|print|output|provide|paste|post|email|submit|export|return|give|include)\b[^.\n]{0,40}\b(private keys?|seed phrases?|mnemonics?|keystores?|wallet passwords?|api keys?)\b/i],
  ["tool_invocation", /\b(call|invoke)\b[^.\n]{0,25}\b(tool|function)\b|\b(run|execute)\b[^.\n]{0,20}\b(the following|this)\b[^.\n]{0,15}\b(command|script|code)\b/i],
];

const NEGATION = /\b(not|never|n't|avoid|without|unless)\b[^.\n]{0,40}$/i;


export interface InjectionFinding {
  doc_id: string;
  pattern: string;
  excerpt: string;
  location: string;
  handling: string;
}

export function scanInjection(doc: DossierDocument): InjectionFinding[] {
  const found: InjectionFinding[] = [];
  (doc.text ?? "").split(/\r?\n/u).forEach((line, i) => {
    for (const [name, re] of INJECTION_PATTERNS) {
      const m = re.exec(line);
      if (m && !NEGATION.test(line.slice(Math.max(0, m.index - 45), m.index + 20))) {
        found.push({ doc_id: doc.doc_id, pattern: name, excerpt: line.trim().slice(0, 160), location: `line ${i + 1}`, handling: "Treated as untrusted data: not executed, not forwarded to any model, and it cannot alter statuses, prices, payees or signing." });
        break;
      }
    }
  });
  return found;
}

// ── Assessment ───────────────────────────────────────────────────────────────
export interface Conflict {
  conflict_id: string;
  field: string;
  values: { source: string; value: number | string }[];
  max_difference_pct: number | null;
  material: boolean;
  note: string;
}

export interface EvidenceGap {
  gap_id: string;
  kind: "missing_field" | "missing_document" | "unverified_claim" | "stale_data" | "unreadable_document" | "conflict" | "injection" | "onchain_anomaly";
  description: string;
  severity: Severity;
  related_claim: string;
}

export interface ChecklistItem {
  item: string;
  required_for: string;
  severity: Severity;
}

export interface EvidenceAssessment {
  status: "complete" | "incomplete" | "insufficient";
  records: EvidenceRecord[];
  conflicts: Conflict[];
  gaps: EvidenceGap[];
  injection_findings: InjectionFinding[];
  counts_by_class: Partial<Record<EvidenceClass, number>>;
  checklist: ChecklistItem[];
  document_claims: { doc_id: string; claims: ExtractedClaim[]; quality: number | null; readable: boolean }[];
}

const relDiffPct = (a: number, b: number) => {
  const ref = Math.max(Math.abs(a), Math.abs(b));
  return ref === 0 ? 0 : (Math.abs(a - b) / ref) * 100;
};

export function assessEvidence(d: Dossier, metrics: MetricResult[], snap: MarketSnapshot, t: Thresholds, now: Date): EvidenceAssessment {
  const assetId = d.asset_id;
  const records: EvidenceRecord[] = [];
  const gaps: EvidenceGap[] = [];
  const conflicts: Conflict[] = [];
  const checklist: ChecklistItem[] = [];
  const injections: InjectionFinding[] = [];
  const docClaims: EvidenceAssessment["document_claims"] = [];

  const rec = (r: Omit<EvidenceRecord, "evidence_id" | "asset_id">) => {
    records.push({ evidence_id: shortId("ev", { c: r.claim, s: r.source_reference, l: r.location_reference, v: r.observed_value }), asset_id: assetId, ...r });
  };
  const gap = (g: Omit<EvidenceGap, "gap_id">) => gaps.push({ gap_id: shortId("gap", { k: g.kind, c: g.related_claim, d: g.description }), ...g });
  const need = (item: string, required_for: string, severity: Severity) => checklist.push({ item, required_for, severity });
  const attested = (claim: string) => (d.independent_verifications ?? []).find((v) => v.claim === claim);
  const doc = (id?: string) => (id ? d.documents.find((x) => x.doc_id === id) : undefined);
  const docOfKind = (kind: DossierDocument["kind"]) => d.documents.find((x) => x.kind === kind);

  // 1. Documents → claims, injection, readability
  for (const dc of d.documents) {
    const readable = dc.readable !== false && !(dc.text === undefined && !dc.extracted);
    const corrected = new Set((dc.extracted ?? []).filter((c) => c.method === "manual_correction").map((c) => c.field));
    const claims: ExtractedClaim[] = [
      ...(dc.extracted ?? []).map((c) => ({ ...c, method: c.method ?? ("structured" as const) })),
      ...(dc.text ? extractFromText(dc.text).filter((c) => !corrected.has(c.field)) : []),
    ];
    docClaims.push({ doc_id: dc.doc_id, claims, quality: dc.extraction_quality ?? null, readable });
    if (!readable) gap({ kind: "unreadable_document", description: `Document "${dc.title}" (${dc.doc_id}) is unreadable or empty; nothing could be extracted.`, severity: "medium", related_claim: dc.doc_id });
    else if ((dc.extraction_quality ?? 1) < 0.6) gap({ kind: "unreadable_document", description: `Extraction quality for "${dc.title}" is low (${dc.extraction_quality}); extracted values need manual review.`, severity: "low", related_claim: dc.doc_id });
    for (const f of scanInjection(dc)) {
      injections.push(f);
      gap({ kind: "injection", description: `Possible prompt-injection content in ${dc.doc_id} (${f.pattern}) at ${f.location}. It was ignored; the document's integrity should be reviewed.`, severity: "high", related_claim: dc.doc_id });
    }
  }
  const docVals = (field: string) => docClaims.flatMap((c) => c.claims.filter((x) => x.field === field).map((x) => ({ doc: c.doc_id, loc: x.location ?? null, value: x.value })));

  // 2. Market / SEC / on-chain observations
  const srcOf = new Map(snap.sources.map((s) => [s.source_id, s]));
  for (const m of snap.metrics) {
    const src = srcOf.get(m.source_id);
    const onchain = src?.kind === "on_chain";
    rec({
      claim: `market:${m.key}`, source_type: onchain ? "on_chain" : "api", source_reference: m.provenance?.reference ?? src?.url ?? src?.name ?? m.source_id,
      location_reference: m.provenance?.detail ?? m.observation_period, observed_value: m.value, observed_at: m.observed_at,
      verification_status: onchain ? "ON_CHAIN_OBSERVED" : "EXTERNALLY_SOURCED",
      review_notes: [...(m.freshness === "stale" ? ["Stale observation."] : []), ...(src?.kind === "cached" ? ["Served from a cached copy."] : []), ...(src?.notes ? [src.notes] : [])],
    });
    if (m.freshness === "stale") gap({ kind: "stale_data", description: `${m.label} is stale (observed ${m.observed_at.slice(0, 10)}).`, severity: m.key === "price_last" || m.key === "token_feed_price" ? "medium" : "low", related_claim: `market:${m.key}` });
  }
  if (snap.data_quality_status === "unavailable") gap({ kind: "missing_field", description: "No market data could be retrieved.", severity: "critical", related_claim: "market" });
  if (!snap.facts.bars.length && snap.data_quality_status !== "unavailable") gap({ kind: "missing_field", description: `No price history for ${d.underlying}.`, severity: "critical", related_claim: "price_last" });
  const fundMissing = !snap.facts.fundamentals && snap.facts.bars.length && snap.limitations.some((l) => /SEC EDGAR/.test(l));
  if (fundMissing) gap({ kind: "missing_field", description: "SEC fundamentals could not be retrieved; valuation and profitability are not assessed.", severity: "medium", related_claim: "fundamentals" });

  // 3. Token wrapper: chain vs claims
  const tok = d.token;
  const tf = snap.facts.token;
  if (!tok) {
    gap({ kind: "missing_field", description: "No token contract supplied: the tokenized wrapper cannot be assessed, only the underlying.", severity: "high", related_claim: "token" });
    need("Provide the BNB Chain token contract address", "token verification", "high");
  } else if (!tf) {
    gap({ kind: "missing_field", description: "Token contract could not be read from the chain (RPC unavailable).", severity: "high", related_claim: "token" });
    need("Retry on-chain verification", "token verification", "high");
  } else if (!tf.has_code) {
    gap({ kind: "onchain_anomaly", description: `No contract code at ${tok.contract_address} on ${tok.chain}: the address is not a deployed contract.`, severity: "critical", related_claim: "token_contract" });
    rec({ claim: "token_contract_exists", source_type: "on_chain", source_reference: tok.contract_address, location_reference: `block ${tf.block_number}`, observed_value: false, observed_at: new Date(tf.block_time * 1000).toISOString(), verification_status: "CONFLICTING", review_notes: ["eth_getCode returned empty."] });
  } else {
    const when = new Date(tf.block_time * 1000).toISOString();
    const loc = `${tok.chain} block ${tf.block_number}`;
    rec({ claim: "token_contract_exists", source_type: "on_chain", source_reference: tok.contract_address, location_reference: loc, observed_value: true, observed_at: when, verification_status: "ON_CHAIN_OBSERVED", review_notes: ["Contract code present. This does not establish who controls or backs it."] });
    const cmp = (field: string, claimed: string | number | undefined, onchain: string | number | null, norm: (x: string | number) => string) => {
      if (claimed === undefined) return;
      if (onchain === null) {
        gap({ kind: "onchain_anomaly", description: `Contract did not return ${field}; the claimed ${field} (${claimed}) could not be checked.`, severity: "medium", related_claim: `token_${field}` });
        return;
      }
      if (norm(claimed) === norm(onchain)) {
        rec({ claim: `token_${field}`, source_type: "on_chain", source_reference: tok.contract_address, location_reference: loc, observed_value: String(onchain), observed_at: when, verification_status: "ON_CHAIN_OBSERVED", review_notes: [`Matches the claimed ${field} (${claimed}).`] });
      } else {
        conflicts.push({ conflict_id: shortId("cf", { field, claimed, onchain }), field: `token_${field}`, values: [{ source: "issuer claim", value: claimed }, { source: `chain (${loc})`, value: onchain }], max_difference_pct: null, material: true, note: `Claimed ${field} "${claimed}" differs from on-chain "${onchain}".` });
        gap({ kind: "conflict", description: `Claimed ${field} "${claimed}" does not match the contract ("${onchain}").`, severity: "high", related_claim: `token_${field}` });
        rec({ claim: `token_${field}`, source_type: "on_chain", source_reference: tok.contract_address, location_reference: loc, observed_value: String(onchain), observed_at: when, verification_status: "CONFLICTING", review_notes: [`Issuer claimed "${claimed}".`] });
      }
    };
    cmp("symbol", tok.claimed_symbol, tf.symbol, (x) => String(x).trim().toLowerCase());
    cmp("name", tok.claimed_name, tf.name, (x) => String(x).trim().toLowerCase());
    cmp("decimals", tok.claimed_decimals, tf.decimals, (x) => String(x));
    if (tf.pausable) rec({ claim: "token_pausable", source_type: "on_chain", source_reference: tok.contract_address, location_reference: loc, observed_value: tf.paused === true ? "paused" : "pausable (currently active)", observed_at: when, verification_status: "ON_CHAIN_OBSERVED", review_notes: ["The contract exposes paused(); an authority may be able to halt transfers."] });
    if (tf.paused) gap({ kind: "onchain_anomaly", description: "The token contract reports paused() = true: transfers may be halted.", severity: "critical", related_claim: "token_paused" });
    if (tf.implementation) rec({ claim: "token_upgradeable", source_type: "on_chain", source_reference: tf.implementation, location_reference: loc, observed_value: tf.implementation, observed_at: when, verification_status: "ON_CHAIN_OBSERVED", review_notes: [`EIP-1967 proxy: contract logic is upgradeable${tf.proxy_admin ? ` by admin ${tf.proxy_admin}` : ""}.`] });
    if (tf.owner) rec({ claim: "token_owner", source_type: "on_chain", source_reference: tf.owner, location_reference: loc, observed_value: tf.owner, observed_at: when, verification_status: "ON_CHAIN_OBSERVED", review_notes: [tf.owner_is_contract ? "Owner is a contract (may be a multisig/timelock — not determined)." : "Owner is an externally owned account (single key)."] });
    for (const e of tf.errors) gap({ kind: "onchain_anomaly", description: `On-chain read issue: ${e}`, severity: "low", related_claim: "token_reads" });
    if (tok.price_feed && !tf.feed) gap({ kind: "onchain_anomaly", description: "The supplied price feed could not be read; token market price is not assessed.", severity: "medium", related_claim: "token_feed" });
    if (tf.feed) {
      const ageD = (tf.block_time - tf.feed.updated_at) / 86_400;
      if (ageD > t.feed_stale_days) gap({ kind: "stale_data", description: `Price feed last updated ${round(ageD, 1)} days before the latest block.`, severity: "medium", related_claim: "token_feed" });
    }
    if (!attested("contract")) need("Independent smart-contract audit of the token (and its upgrade/pause controls)", "contract risk", "medium");

    // supply vs document-stated supply
    for (const v of docVals("token_supply")) {
      if (tf.total_supply === null) continue;
      const diff = relDiffPct(v.value, tf.total_supply);
      if (diff > t.supply_conflict_pct) {
        conflicts.push({ conflict_id: shortId("cf", { f: "supply", d: v.doc, v: v.value }), field: "token_supply", values: [{ source: `${v.doc}${v.loc ? ` (${v.loc})` : ""}`, value: v.value }, { source: `chain (${loc})`, value: tf.total_supply }], max_difference_pct: round(diff, 2), material: diff >= 5, note: `Document-stated supply differs from on-chain supply by ${round(diff, 2)}%.` });
        gap({ kind: "conflict", description: `${v.doc} states ${v.value} tokens outstanding; the contract reports ${tf.total_supply}.`, severity: diff >= 5 ? "high" : "medium", related_claim: "token_supply" });
      } else {
        rec({ claim: "token_supply_document_check", source_type: "document", source_reference: v.doc, location_reference: v.loc, observed_value: v.value, observed_at: null, verification_status: "DOCUMENT_EXTRACTED", review_notes: ["Agrees with on-chain supply; document agreement is not independent verification."] });
      }
    }
  }

  // 4. Custody / backing claims
  const claims = d.claims;
  const shareClaim = claims?.shares_held_in_custody;
  for (const v of docVals("shares_in_custody")) {
    if (shareClaim !== undefined && relDiffPct(v.value, shareClaim) > t.supply_conflict_pct) {
      conflicts.push({ conflict_id: shortId("cf", { f: "custody", d: v.doc, v: v.value }), field: "shares_held_in_custody", values: [{ source: "dossier claim", value: shareClaim }, { source: `${v.doc}${v.loc ? ` (${v.loc})` : ""}`, value: v.value }], max_difference_pct: round(relDiffPct(v.value, shareClaim), 2), material: relDiffPct(v.value, shareClaim) >= 5, note: "Custody share counts disagree between the dossier and a document." });
      gap({ kind: "conflict", description: `Shares held in custody: dossier says ${shareClaim}, ${v.doc} says ${v.value}.`, severity: "high", related_claim: "custody" });
    }
  }
  const custodyDoc = doc(claims?.custody_doc_id) ?? docOfKind("custody_attestation");
  const custodyVer = attested("custody");
  if (!claims?.custodian && !custodyDoc && !custodyVer) {
    rec({ claim: "custody", source_type: "user_input", source_reference: "dossier.claims", location_reference: null, observed_value: null, observed_at: null, verification_status: "MISSING", review_notes: ["No custodian or custody evidence provided."] });
    gap({ kind: "missing_field", description: "Custody of the underlying shares is not described or evidenced.", severity: tok ? "high" : "medium", related_claim: "custody" });
    need("Name the custodian and attach a custody attestation", "custody and backing", "high");
  } else if (custodyVer) {
    rec({ claim: "custody", source_type: "registry", source_reference: custodyVer.reference, location_reference: null, observed_value: claims?.custodian ?? null, observed_at: custodyVer.verified_at, verification_status: "INDEPENDENTLY_VERIFIED", review_notes: [`Attested by ${custodyVer.verifier}. Sentinel has not re-performed this verification.`] });
  } else {
    rec({ claim: "custody", source_type: custodyDoc ? "document" : "user_input", source_reference: custodyDoc?.doc_id ?? "dossier.claims", location_reference: null, observed_value: claims?.custodian ?? null, observed_at: null, verification_status: custodyDoc ? "DOCUMENT_EXTRACTED" : "UNVERIFIED", review_notes: [custodyDoc ? "A custody document was supplied; no independent attestation confirms it." : "Custody is an issuer claim with no supporting document."] });
    gap({ kind: custodyDoc ? "unverified_claim" : "missing_document", description: custodyDoc ? "Custody is supported by a supplied document only; not independently verified." : "Custody is an unsupported issuer claim (no custody attestation attached).", severity: custodyDoc ? "medium" : "high", related_claim: "custody" });
    need("Independent confirmation of custody (custodian letter / attestation by an independent party)", "custody and backing", custodyDoc ? "medium" : "high");
  }
  const backingClaim = claims?.backing;
  const backingVer = attested("backing");
  const reserveDoc = docOfKind("reserve_report");
  if (backingVer) {
    rec({ claim: "backing", source_type: "registry", source_reference: backingVer.reference, location_reference: null, observed_value: backingClaim ?? null, observed_at: backingVer.verified_at, verification_status: "INDEPENDENTLY_VERIFIED", review_notes: [`Attested by ${backingVer.verifier}.`] });
  } else if (!backingClaim || backingClaim === "unknown") {
    rec({ claim: "backing", source_type: "user_input", source_reference: "dossier.claims", location_reference: null, observed_value: null, observed_at: null, verification_status: "MISSING", review_notes: ["Backing structure not stated."] });
    gap({ kind: "missing_field", description: "How the token is backed (1:1 shares, partial, synthetic) is not stated.", severity: tok ? "high" : "medium", related_claim: "backing" });
    need("State the backing structure and provide a reserve/proof-of-reserves report", "custody and backing", "high");
  } else {
    rec({ claim: "backing", source_type: reserveDoc ? "document" : "user_input", source_reference: reserveDoc?.doc_id ?? "dossier.claims", location_reference: null, observed_value: backingClaim, observed_at: null, verification_status: reserveDoc ? "DOCUMENT_EXTRACTED" : "UNVERIFIED", review_notes: [backingClaim === "synthetic" ? "Synthetic exposure: holders may have no claim on the underlying shares." : reserveDoc ? "Reserve document supplied; not independently verified." : "Backing is an issuer claim without a reserve report."] });
    gap({ kind: reserveDoc ? "unverified_claim" : "missing_document", description: reserveDoc ? "Backing is supported by a reserve document only; not independently verified." : `Backing ("${backingClaim}") is unsupported: no reserve report or attestation.`, severity: backingClaim === "synthetic" ? "high" : reserveDoc ? "medium" : "high", related_claim: "backing" });
    need("Independent proof of reserves / reserve attestation", "custody and backing", reserveDoc ? "medium" : "high");
  }
  if (claims?.proof_of_reserves_url) rec({ claim: "proof_of_reserves_url", source_type: "user_input", source_reference: claims.proof_of_reserves_url, location_reference: null, observed_value: claims.proof_of_reserves_url, observed_at: null, verification_status: "UNVERIFIED", review_notes: ["URL supplied by the issuer; Sentinel does not fetch or trust it."] });

  // 5. Redemption, legal, audit, terms
  if (claims?.redemption) {
    const rv = attested("redemption");
    const terms = doc(claims.terms_doc_id) ?? docOfKind("issuer_terms");
    rec({ claim: "redemption", source_type: rv ? "registry" : terms ? "document" : "user_input", source_reference: rv?.reference ?? terms?.doc_id ?? "dossier.claims", location_reference: null, observed_value: claims.redemption.available, observed_at: rv?.verified_at ?? null, verification_status: rv ? "INDEPENDENTLY_VERIFIED" : terms ? "DOCUMENT_EXTRACTED" : "UNVERIFIED", review_notes: [claims.redemption.available ? "Redemption is claimed to be available." : "Issuer states redemption is NOT available."] });
    if (!rv && claims.redemption.available) {
      gap({ kind: terms ? "unverified_claim" : "missing_document", description: terms ? "Redemption terms are documented but not independently verified." : "Redemption is claimed but no issuer terms document is attached.", severity: "medium", related_claim: "redemption" });
      need("Issuer terms covering redemption rights, minimums, fees and settlement", "redemption", "medium");
    }
  } else {
    gap({ kind: "missing_field", description: "Redemption rights are not described.", severity: "medium", related_claim: "redemption" });
    need("Describe redemption (who can redeem, minimum, fee, settlement time)", "redemption", "medium");
  }
  const audit = doc(claims?.audit_doc_id) ?? docOfKind("audit_report");
  if (!attested("audit") && !audit) {
    gap({ kind: "missing_document", description: "No audit report (contract or reserves) is attached.", severity: "medium", related_claim: "audit" });
    need("Smart-contract and/or reserve audit report", "contract and reserve assurance", "medium");
  } else if (audit && !attested("audit")) {
    rec({ claim: "audit", source_type: "document", source_reference: audit.doc_id, location_reference: null, observed_value: audit.title, observed_at: audit.document_date ?? null, verification_status: "DOCUMENT_EXTRACTED", review_notes: ["Audit document supplied; auditor identity and scope not verified by Sentinel."] });
  } else if (attested("audit")) {
    const a = attested("audit")!;
    rec({ claim: "audit", source_type: "registry", source_reference: a.reference, location_reference: null, observed_value: null, observed_at: a.verified_at, verification_status: "INDEPENDENTLY_VERIFIED", review_notes: [`Attested by ${a.verifier}.`] });
  }
  const legal = doc(claims?.legal_opinion_doc_id) ?? docOfKind("legal_opinion");
  if (!attested("legal") && !legal) {
    gap({ kind: "missing_document", description: "No legal opinion on the token's legal nature and holder rights.", severity: "medium", related_claim: "legal" });
    need("Legal opinion on holder rights, securities treatment and transfer restrictions", "legal structure", "medium");
  } else if (legal && !attested("legal")) {
    rec({ claim: "legal", source_type: "document", source_reference: legal.doc_id, location_reference: null, observed_value: legal.title, observed_at: legal.document_date ?? null, verification_status: "DOCUMENT_EXTRACTED", review_notes: ["Legal document supplied; not reviewed by Sentinel."] });
  }
  if (!doc(claims?.terms_doc_id) && !docOfKind("issuer_terms")) {
    gap({ kind: "missing_document", description: "No issuer terms / prospectus is attached.", severity: "low", related_claim: "terms" });
    need("Issuer terms or prospectus", "holder rights", "low");
  }
  if (claims?.kyc_required || claims?.transfer_restrictions) rec({ claim: "transfer_restrictions", source_type: "user_input", source_reference: "dossier.claims", location_reference: null, observed_value: claims.kyc_required ? "KYC required" : "transfer restrictions", observed_at: null, verification_status: "UNVERIFIED", review_notes: ["Restrictions are an issuer claim; liquidity may be limited to eligible holders."] });

  // 6. Calculated metrics
  for (const m of metrics) {
    rec({ claim: m.id, source_type: "calculation", source_reference: `${m.methodology_version}:${m.formula}`, location_reference: m.period, observed_value: m.value, observed_at: null, verification_status: m.status === "OK" ? "CALCULATED" : "MISSING", review_notes: m.status === "OK" ? m.warnings : [m.status, ...m.warnings] });
  }
  if (d.assumptions?.length) for (const a of d.assumptions) rec({ claim: `assumption: ${a.slice(0, 60)}`, source_type: "user_input", source_reference: "dossier.assumptions", location_reference: null, observed_value: a, observed_at: null, verification_status: "USER_SUPPLIED", review_notes: ["User assumption; not verified."] });

  const counts: Partial<Record<EvidenceClass, number>> = {};
  for (const r of records) counts[r.verification_status] = (counts[r.verification_status] ?? 0) + 1;
  const critical = gaps.some((g) => g.severity === "critical" && (g.kind === "missing_field"));
  const material = gaps.some((g) => g.severity === "high" || g.severity === "medium" || g.severity === "critical");
  const seen = new Set<string>();
  return {
    status: critical ? "insufficient" : material || conflicts.length ? "incomplete" : "complete",
    records, conflicts, gaps, injection_findings: injections, counts_by_class: counts,
    checklist: checklist.filter((c) => (seen.has(c.item) ? false : (seen.add(c.item), true))), document_claims: docClaims,
  };
}
