#!/usr/bin/env bash
# Run once while the network is good (e.g. before leaving for the venue), with the SAME
# SENTINEL_DATA_DIR you will start the agent with. See DEMO.md "If the network fails".
set -euo pipefail
cd "$(dirname "$0")/../app/agent"
npx tsx scripts/warm-cache.mts
