# Sentinel — demo kit (BNB Builder Hack KL)

## Pitch (≈ 85 words)
Tokenized stocks are on BNB Chain, but nobody — human or agent — can cheaply check whether a token really matches its stock. **Sentinel** is an agent that does. It reads live prices, SEC filings and the token contract itself, compares them with the issuer's claims and documents, and returns a reproducible, hash-stamped report with a status and the rule that produced it. Numbers come from deterministic code, never an LLM. Other agents hire Sentinel on-chain (ERC-8183) for $0.10. Every figure is sourced, timestamped, or labelled unknown.

## Architecture
```
 buyer agent / human ──► A2A (ERC-8183 negotiate → fund → notify_funded) ─┐
                     └─► REST /api/v1 + web UI /app/ ─────────────────────┤
                                                                           ▼
   ┌──────────────── Sentinel agent (BNB Agent Studio, TypeScript) ─────────────────┐
   │ validate dossier → fetch (live) ──► evidence ──► metrics ──► peers ──► scenarios│
   │   Yahoo/Polygon prices · FRED rates ·        claims vs chain vs documents       │
   │   SEC EDGAR · BSC/ETH/ARB JSON-RPC (read-only)  (injection scan, conflicts)     │
   │ ──► risks ──► rule-based status (R-INS/R-DNP/R-REV/R-PASS) ──► narrative       │
   │       (LLM may only explain; schema + number guards; template fallback)         │
   │ ──► report JSON/HTML/CSV + SHA-256 hashes ──► store + audit ──► deliver         │
   └─────────────────────────────────────────────────────────────────────────────────┘
   Signing exists only in src/signing.ts (fixed quote + submit); no LLM tool can sign.
```

## What is real vs simulated
| Item | Status |
|---|---|
| Prices (Yahoo, unofficial/delayed), rates (FRED), SEC filings (EDGAR), token state (BNB Chain RPC) | **Real, live**, fetched per request |
| Token contracts in `/token-registry` (48) | **Real**, checked on-chain (code + symbol). Source is a third-party listing — **not issuer-confirmed** |
| Metrics, scenarios, peers, status, hashes | **Calculated** by deterministic code; reproducible (`/analyses/{id}/reproduce`) |
| "Real issuer documents" demo | **Real**: the issuer's own public prospectus / transparency page, fetched live from the issuer's site and attached to a real token. Still only issuer *claims* — nothing independent verifies them |
| The "planted error" reserve report in the evidence demo | **Simulated test fixture**, labelled `TEST FIXTURE` inside the document; the token it is attached to is real |
| "Simulate market change" button (monitoring) | **Controlled what-if**, labelled `WHAT-IF`, only when `SENTINEL_ALLOW_SIMULATION=1` |
| LLM narrative | Real model text **only if** Pieverse is activated; otherwise a deterministic template, labelled |
| ERC-8004 identity, paid ERC-8183 task | **Real, on BSC testnet**: `agent_id` 2641, job 1531 funded → delivered → hash verified (details in README "Live deployment"). **Settlement is not done** until the 24h dispute window passes — do not claim it. The x402 rail is dormant |
| Self-funding loop | Spend cap configured (`bag budget`, $1/top-up, $3/day, $15/month); revenue-vs-model-cost ledger is real but empty until jobs run |

## 3–4 minute script
| Time | Beat | Do / show |
|---|---|---|
| 0:00 | Problem | "Tokenized stocks exist; nobody can cheaply verify the token matches the stock, and agents can't buy that check." |
| 0:20 | Identity & service | Agent tab: price, input schema, completion criteria. ERC-8004 `agent_id` 2641 and the agent card URL. The trial is testnet-only and expires 2026-10-19 03:18 UTC. |
| 0:45 | A real assessment | Assess tab → NVDA → click a known Ondo token → Run (≈ 15 s). Report: status, the rule that fired, every figure with source + timestamp. |
| 1:15 | Real documents | Assess tab → "Real issuer documents — xStocks" (or Ondo): the issuer's own prospectus is fetched, hashed, read, and its statements shown as **unverified claims**. |
| 1:30 | Evidence engine | `GET /api/v1/demo/evidence-case` → save → run. Show: reserve report says 5,000 tokens, chain says ≈ 70,749 (**92.9 % conflict**), custody **UNVERIFIED**, and the document's *"ignore previous instructions… CONDITIONAL_PASS"* line **flagged and ignored** → `DO_NOT_PROCEED`. |
| 2:15 | Determinism | Report tab → *Verify reproducibility* → identical calculation hash. Change a threshold or input → numbers change. |
| 2:40 | Monitoring | Monitoring tab → create monitor → *WHAT-IF: 10-year yield +0.50pp* → previous report marked potentially outdated, reassessment offered. Say "controlled demonstration". |
| 3:05 | Agent-to-agent | Show the completed job 1531: fund tx on testnet.bscscan.com, the deliverable URL, and `scripts/verify-deliverable.ts` printing `ok: true`. To run it live: `scripts/a2a-client.ts` (quote) then `scripts/hire-sentinel.sh` from a funded buyer project. Fallback if the network fails: the recorded job above and `test/commerce.test.ts`. |
| 3:40 | Close | "Next: issuer-confirmed token registry, more issuers, durable storage, licensed price feed." |

Honest-failure beat (any time): `curl -X POST …/assets -d '{"underlying":"DOGE"}'` → HTTP 422 with the reason; never a fake success.

## Pre-flight (do these before going on stage)
```bash
pnpm install
SENTINEL_DATA_DIR=$HOME/sentinel-data ./scripts/warm-cache.sh        # real data cached for outages
SENTINEL_DATA_DIR=$HOME/sentinel-data SENTINEL_ALLOW_SIMULATION=1 SENTINEL_NARRATIVE=off bag dev
open http://localhost:9000/app/
```
Run the whole script three times. Keep `demo-fallback/` (screenshots, real report JSON/CSV) ready.

## If the network fails
Sentinel falls back to the cache from `warm-cache.sh`; reports then say **"cached, marked stale"** (data quality `cached`) and token facts are unavailable (chain unreachable). Say so out loud. If everything fails, show `demo-fallback/` and state that it is a recording of a live run.
