# Sentinel

**Market intelligence meets RWA underwriting — for tokenized stocks and ETFs on BNB Chain.** Sentinel is an agentic service built on **BNB Agent Studio**. For a tokenized security it checks three things with **real data**, then returns a transparent, rule-based assessment to people (web app, REST API) and to other AI agents (ERC-8183 / x402 paid tasks):

1. **The underlying** — AAPL, GOOGL, NVDA, META, TSLA, AMZN, NFLX, MSFT, QQQ, SPY: prices, volatility, drawdown, beta, VaR, valuation and cash-flow from SEC filings, rates from FRED.
2. **The token wrapper** — the BEP-20 contract read directly from BNB Chain (code, name/symbol/decimals, supply, owner, pause and upgrade controls, price feed) and compared with what the issuer claims.
3. **The evidence** — custody, backing, redemption, audit and legal claims are labelled UNVERIFIED until a referenced attestation exists; documents are scanned, never trusted.

> Decision support only. Not investment, legal or tax advice. Sentinel does not verify custody, backing or legal ownership.

## Data — what is real

| Item | Source | Notes |
| --- | --- | --- |
| Prices, dividends | Yahoo Finance chart API | **Unofficial, delayed, no SLA** — disclosed in every report |
| 10-year / 3-month Treasury yields | FRED (St. Louis Fed) CSV | official |
| Revenue, income, EPS, cash flow, debt, shares | SEC EDGAR XBRL company facts | official; TTM = FY + YTD − prior-year YTD; each figure links to its filing accession |
| Token contract facts, supply, admin/upgrade controls, price feed | BNB Chain JSON-RPC (read-only) | at a stated block; Sentinel never signs or sends transactions |
| Custody, backing, redemption, legal | issuer / user claims + uploaded documents | **claims, not facts**, until independently attested |

Nothing is simulated. If a source fails, the metric is absent and the report says so; a labelled cached copy (marked stale) may be used. No fixtures ship in the runtime — test fakes live only under `app/agent/test/`. Not assessed (and said so in every report): on-chain DEX liquidity, holder concentration, bridge risk, issuer solvency, news/event risk, ETF holdings look-through.

## Engines (`app/agent/src/sentinel/`)

| Module | Role |
| --- | --- |
| `sources.ts`, `chain.ts`, `market.ts` | Real data retrieval, provenance, freshness, caching, market-regime analysis |
| `stats.ts`, `metrics.ts` | Deterministic statistics and metrics (formula, inputs, period recorded; missing ⇒ MISSING, never imputed) |
| `evidence.ts`, `documents.ts` | Claims vs chain vs documents, conflicts, gaps, injection scan, PDF/text extraction |
| `scenarios.ts` | Hypothetical stresses: market (beta-implied), volatility, drawdown replay, de-rating, EPS shock, token depeg, combined |
| `risk.ts`, `assessment.ts` | Token / underlying / market risk registers, coverage of what was *not* assessed, ordered status rules |
| `thesis.ts` | LLM narrative that is schema- and number-checked against the facts, else a labelled template |
| `service.ts`, `commerce.ts`, `monitor.ts` | REST API, agent commerce adapter, monitoring and reassessment |

Status rules (ordered, disclosed in each report): `INSUFFICIENT_DATA` > `DO_NOT_PROCEED` (no contract code, paused, custody < 90% of implied shares, ≥ 10% depeg, unprofitable and cash-burning) > `NEEDS_REVIEW` (no/unreadable token, unverified custody/backing, conflicts, injection, high risks, stale data, unfavourable market, redemption gaps) > `CONDITIONAL_PASS`. Market strength can only downgrade, never upgrade or offset a structure/evidence concern.

> **Judges:** pitch, architecture diagram, real-vs-simulated table and the demo script are in [`DEMO.md`](DEMO.md).

## Verify in 5 minutes (for judges)

```bash
pnpm install && scripts/demo.sh NVDA        # cold start → real report → reproduce → forced error (≈40 s measured)
cd app/agent && npx tsx --test test/*.test.ts   # 116+ tests, no network needed
```
`scripts/demo.sh` starts the agent, assesses a real ticker from live Yahoo/FRED/SEC data, prints the status and the **rule that produced it**, the number of computed scenarios, data quality and source count, then re-computes the report from stored inputs and checks the **hash is identical**, and finally sends a bad request to show an honest `422` (never a fake success). Open `http://localhost:9000/app/` for the UI.

| Check | Where to look |
|---|---|
| Complete report from a submitted dossier | `POST /api/v1/investment-assessment` or the UI **Assess** tab |
| Status names its rule | report header / `assessment.determining_rules` |
| ≥ 3 scenarios | report section 9 (8–10 computed) |
| Source + timestamp on every figure | report section 4; limitations listed where a source failed |
| Known-answer tests | `app/agent/test/knownanswer.test.ts`, `data.test.ts` |
| Honest failures | `test/api.test.ts` "forced failures", `test/commerce.test.ts` |
| Agent identity / paid testnet job | **Done on BSC testnet** — ERC-8004 `agent_id` 2641; paid ERC-8183 job **1531** (0.10 U) funded, delivered and hash-verified; see "Live deployment" below. The job is `COMPLETED` on-chain: the seller received the 0.10 U payment |
| Real issuer documents | `GET /api/v1/demo/real-docs-case?symbol=NVDA&issuer=xstocks` (or `ondo`) — fetches the issuer's own public documents and attaches them to a real token |
| Planted-error evidence demo | `GET /api/v1/demo/evidence-case` (real token + labelled fixture document: conflict, unverified claim, ignored injection) |
| Fallback if network/testnet fails | `demo-fallback/` — screenshots, a real report (JSON/CSV) and a portfolio sample captured from a live run |

## Run it

```bash
npm i -g @bnbagent/studio-cli && bag skills install   # once
pnpm install
(cd app/agent && bag wallet new --generate-password)   # throwaway testnet wallet
bag dev                                                # http://localhost:9000/app/
```

- Web app `/app/`: Assess → Market → Token & underlying → Report → Agent service → Monitoring.
- API `/api/v1`: `GET /services`, `GET/POST /assets`, `POST /market-intelligence` (incl. peers), `POST /peers` (peer benchmarking + valuation context), `POST /token-verification` (alias `POST /underwriting`), `POST /portfolio` (concentration, correlation, stress), `POST /investment-assessment`, `GET /analyses/{id}` (`/report`, `/audit`, `/reproduce`, `/review`), monitors (`/monitors`, `/monitors/{id}/check`), `GET /agent`, `GET /agent/economics`, `GET /agent/metrics` (usage KPIs / north star), `GET /etf-holdings/{SPY}`, `GET /me`, `GET /billing/usage` and `GET /export` (admin), `?format=csv` on reports, `DELETE /assets/{id}`.
- A2A agent card: `/.well-known/agent-card.json`.
- Tests: `cd app/agent && pnpm test` (statistics known-answers, SEC TTM extraction, on-chain decoding, every status rule, evidence conflicts, injection, scenarios, reproducibility, API/auth/tenants, commerce) and `pnpm typecheck`.

A dossier is small: `{"underlying":"NVDA"}` for the underlying alone, or add `token` (`contract_address` from the issuer's **official** list, optional `price_feed`, `tokens_per_share`), `claims`, `documents`, `independent_verifications`, `position`. Sentinel does not bundle token addresses — it will not invent one.

Environment: `SENTINEL_DATA_DIR`, `SENTINEL_API_KEYS` (enables auth + tenant isolation), `SENTINEL_REQUIRE_AUTH=1`, `SENTINEL_ALLOW_OPEN_API=1`, `SENTINEL_RATE_LIMIT_PER_MIN`, `SENTINEL_NARRATIVE=off`, `SENTINEL_OFFLINE=1`, `SENTINEL_THRESHOLDS_JSON`, `SENTINEL_BSC_RPC` / `SENTINEL_BSC_TESTNET_RPC`, `SENTINEL_SEC_USER_AGENT` or `SENTINEL_CONTACT_EMAIL` (SEC asks for a contact in the User-Agent), `SENTINEL_MONITOR_INTERVAL_MINUTES`, `SENTINEL_MONITOR_AUTO_REASSESS=1`, `SENTINEL_ALLOW_SIMULATION=1` (labelled what-if overrides for testing monitoring; **off by default**), `SENTINEL_AGENT_ID` / `SENTINEL_IDENTITY_TX`.

A *deployed* runtime with no API keys refuses the REST API instead of exposing the open demo tenant.

## Hiring Sentinel (agent-to-agent)

1. Read `GET /api/v1/services` (price, schema, universe, completion criteria, error codes).
2. `negotiate` with the task (a dossier, `{"sentinel":"v1","asset_id":"…"}`, or `equity:NVDA`). Tasks Sentinel can't analyse are **refused before funding**.
3. Fund the ERC-8183 job and send `notify_funded`; Sentinel verifies on-chain, fetches live data, analyses and submits the report. A failed analysis — or a data outage — submits **nothing**, so the buyer can use the refund/expiry path.
4. Fetch the deliverable and check it: `cd app/agent && npx tsx ../../scripts/verify-deliverable.ts deliverable.json`. See `scripts/hire-sentinel.sh`.

## Live deployment (BNB Chain managed-platform trial, BSC testnet)

Deployed 2026-10-17 with `bag deploy --provider bnb`; the 48h trial runtime is deleted at **2026-10-19 03:18 UTC**.

| | |
|---|---|
| Agent card | https://bnbagent-api.bnbchain.world/v1/rt/01M53XVV1VPE9MS604Y48VB4PM/.well-known/agent-card.json |
| ERC-8004 identity | `agent_id` 2641 (seller wallet `0x6571415fc43208726012226C419a29d3C982e2C3`) |
| A2A access | OAuth2 `client_credentials` from the platform (`bag platform invoke-client new`) |
| Paid-task proof | job **1531**: signed quote 0.10 U → buyer funded the escrow (tx `0x20b4fafa…d8de`) → `notify_funded` → report SUBMITTED on-chain |
| Deliverable | https://bnbagent-api.bnbchain.world/v1/deliverables/sha256/1ade67f5354d688c9fe081b4fb1b5a282dbf6e13e6fba4636f6db6d9f2bc7702.json (sha-256 matches the URL; report hash recomputed by `scripts/verify-deliverable.ts`) |
| Second paid job | job **1532** (fresh run of `scripts/hire-sentinel.sh`): funded, delivered, deliverable hash verified; payment moves to `COMPLETED` after the escrow releases |
| See it in the UI | Agent tab → "Look up an on-chain job" (or `GET /api/v1/agent/jobs/{id}`) reads the job straight from the chain: status, parties, budget, deliverable hash. Read-only; nothing is signed |
| Find any delivered report | Agent tab → **Recent jobs** lists every job funded for this agent with its task, status and a **report** link; **Open** shows the task, the result headline, the report hash and whether the file’s SHA-256 matches its link. The link is recorded on-chain (policy contract `JobInitialised` event), or run `bag erc8183 fetch <job_id>` from the buyer project |

The delivered NVDA report is `NEEDS_REVIEW`: no token contract or custody evidence was supplied in the task, so it lists them as required diligence. The x402 rail is dormant (no B402 merchant credentials). The managed runtime's file store is not durable. Reproduce the quote with `scripts/a2a-client.ts`; the buyer side is `scripts/hire-sentinel.sh`.

## Known gaps

No OCR for scanned PDFs · Yahoo Finance is unofficial (swap in a licensed feed for production) · custody/backing can only be checked against supplied evidence · no DEX-liquidity or holder-concentration data · ETFs: no holdings look-through · file store is not durable on an ephemeral managed runtime (set `SENTINEL_DATA_DIR`) · x402 replay protection is process-local (Studio advisory M01) · a browser UI behind an AgentCore Cognito authorizer needs a token.

## Accounts, roles and billing
`SENTINEL_API_KEYS="secret;tenant=acme;role=analyst;user=alice,secret2;tenant=acme;role=viewer;user=bob"` — roles: `viewer` (read), `analyst` (run, upload, review), `admin` (delete, billing, export). A bare key is an admin of its own private tenant. `GET /billing/usage?month=YYYY-MM` meters and prices usage (`SENTINEL_BILLING_JSON` sets unit prices; it does not collect payment). Extra stocks/ETFs: `SENTINEL_EXTRA_ASSETS_JSON='{"AMD":{"name":"Advanced Micro Devices","kind":"stock","cik":2488}}'`.

## More features (see `docs/PRD.md`)
- **SSO:** `SENTINEL_OIDC_ISSUER` + `SENTINEL_OIDC_AUDIENCE` accept IdP-issued RS256 JWTs (claims `tenant`, `role`).
- **Approval gate / assignment:** `SENTINEL_REQUIRE_APPROVAL=1`; `POST /analyses/{id}/assign`.
- **Webhooks:** `POST /webhooks` (admin, https only, HMAC-signed); verify with `sdk/sentinel-client.ts` `verifyWebhook`.
- **Chains:** bsc, bsc-testnet, ethereum, arbitrum, base, polygon (`SENTINEL_<CHAIN>_RPC` to override). Known tokens: `GET /token-registry` (third-party listing, on-chain checked — confirm with the issuer).
- **OCR:** PNG/JPEG and scanned PDFs when `tesseract.js` and `@napi-rs/canvas` are installed (optional; `SENTINEL_OCR=off` disables).
- **Licensed prices:** `SENTINEL_PRICE_PROVIDER=polygon` + `POLYGON_API_KEY`.
- **API contract / SDK:** `GET /api/v1/openapi.json`, `sdk/sentinel-client.ts`.
