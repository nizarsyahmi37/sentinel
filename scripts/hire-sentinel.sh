#!/usr/bin/env bash
# Buyer-side walkthrough: hire a deployed Sentinel through ERC-8183 on BSC testnet.
# Needs a SEPARATE funded buyer wallet (tBNB for gas + testnet U) — run from a buyer
# project created with `bag init` (never reuse the seller's wallet).
#
#   SELLER=0x… ./scripts/hire-sentinel.sh [task]      # task: equity:AAPL | dossier JSON | {"sentinel":"v1","asset_id":"…"}
#
# Each step prints what it does; nothing is assumed to have succeeded.
set -euo pipefail
: "${SELLER:?set SELLER to the Sentinel agent wallet address}"
TASK="${1:-equity:AAPL}"
NET="${NETWORK:-bsc-testnet}"

echo "1) Read the service catalogue (price, schema, completion criteria)"
[ -n "${SENTINEL_URL:-}" ] && curl -fsS "$SENTINEL_URL/api/v1/services" | head -c 1200 && echo

echo "2) Buy: createJob → register → setBudget → fund (negotiation is skipped when buying by --provider)"
bag erc8183 buy --provider "$SELLER" --task "$TASK" --budget-usd "${PRICE_USD:-0.10}" --deadline-min 30 --network "$NET" | tee /tmp/sentinel-buy.out
JOB=$(awk -F': *' '/job_id:/{print $2; exit}' /tmp/sentinel-buy.out)
echo "job_id=$JOB"

echo "3) Tell Sentinel the job is funded (A2A notify_funded) — send this DataPart to the seller's A2A endpoint:"
echo "   {\"skill\":\"notify_funded\",\"job_id\":$JOB}"

echo "4) Poll the chain until SUBMITTED"
for _ in $(seq 1 40); do
  bag erc8183 status "$JOB" --network "$NET" | tee /tmp/sentinel-status.out
  grep -q SUBMITTED /tmp/sentinel-status.out && break
  sleep 15
done

echo "5) Fetch the deliverable URL, download it, and verify its hash"
bag erc8183 fetch "$JOB" --network "$NET"
echo "   curl -o deliverable.json <deliverable_url> && tsx scripts/verify-deliverable.ts deliverable.json"

echo "6) Settle: approve after the 24h dispute window, or dispute within it"
echo "   bag erc8183 settle $JOB --action approve   # or --action dispute"
