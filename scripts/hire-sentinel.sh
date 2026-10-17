#!/usr/bin/env bash
# Buyer-side walkthrough: hire the deployed Sentinel through ERC-8183 on BSC testnet.
# Run from a SEPARATE funded buyer project (`bag init`, never reuse the seller's wallet).
# The platform gateway is OAuth-gated, so the signed quote is fetched out-of-band with
# scripts/a2a-client.ts and anchored on-chain with `bag erc8183 buy --quote-json`.
#
#   SELLER=0x… SENTINEL_REPO=/path/to/sentinel ./scripts/hire-sentinel.sh [task]
#   task: equity:NVDA (default) | dossier JSON | {"sentinel":"v1","asset_id":"…"}
#
# Needs SENTINEL_CLIENT_ID / SENTINEL_CLIENT_SECRET in the sentinel repo's .studio/.env.local
# (`bag platform invoke-client new`, then `bag env set …`). Nothing is assumed to have succeeded.
set -euo pipefail
: "${SELLER:?set SELLER to the Sentinel agent wallet address}"
REPO="${SENTINEL_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
TASK="${1:-equity:NVDA}"
NET="${NETWORK:-bsc-testnet}"
QUOTE="$(mktemp -t sentinel-quote.XXXXXX)"
trap 'rm -f "$QUOTE"' EXIT

echo "1) Negotiate: get a signed quote (no payment happens; it expires in ~15 minutes)"
(cd "$REPO/app/agent" && TASK="$TASK" QUOTE_OUT="$QUOTE" pnpm exec tsx ../../scripts/a2a-client.ts | grep -E "token ok|HTTP|price|saved")

echo "2) Buy: createJob → registerJob → setBudget → fund (anchors the signed quote)"
bag erc8183 buy --provider "$SELLER" --task "$TASK" --quote-json "$QUOTE" --budget-usd "${PRICE_USD:-0.10}" --deadline-min 30 --network "$NET" | tee /tmp/sentinel-buy.out
JOB=$(awk -F': *' '/^job_id:/{print $2; exit}' /tmp/sentinel-buy.out)
echo "job_id=$JOB"

echo "3) notify_funded: Sentinel verifies the funded job, analyses and submits the report"
(cd "$REPO/app/agent" && TASK="$TASK" JOB_ID="$JOB" pnpm exec tsx ../../scripts/a2a-client.ts | sed -n '/notify_funded/,$p' | grep -E "HTTP|status|job_id")

echo "4) Poll the chain until SUBMITTED (typically 1-3 minutes)"
for _ in $(seq 1 40); do
  S=$(bag erc8183 status "$JOB" --network "$NET" | awk '/^status:/{print $2}')
  echo "   $(date +%T) $S"
  [ "$S" != "FUNDED" ] && break
  sleep 15
done

echo "5) Fetch the deliverable URL, download it, and verify its hash"
bag erc8183 fetch "$JOB" --network "$NET" | grep -E "^(job_id|deliverable_url):"
echo "   curl -o deliverable.json <deliverable_url> && (cd $REPO/app/agent && pnpm exec tsx ../../scripts/verify-deliverable.ts <path>/deliverable.json)"

echo "6) Settle: approve after the 24h dispute window, or dispute within it"
echo "   bag erc8183 settle $JOB --action approve   # or --action dispute"
