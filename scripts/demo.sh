#!/usr/bin/env bash
# One-command local demo: starts Sentinel, runs a real assessment, prints the verification facts.
# Usage: scripts/demo.sh [SYMBOL]   (default NVDA). Needs: bag, curl, python3. Real data; no secrets used.
set -euo pipefail
SYM="${1:-NVDA}"; PORT=9000; BASE="http://localhost:$PORT/api/v1"
DATA="$(mktemp -d)"; trap 'kill $PID 2>/dev/null || true; rm -rf "$DATA"' EXIT
START=$(date +%s)
SENTINEL_DATA_DIR="$DATA" SENTINEL_ALLOW_SIMULATION=1 SENTINEL_NARRATIVE=off bag dev >"$DATA/dev.log" 2>&1 & PID=$!
for _ in $(seq 1 60); do curl -sf -m 2 "$BASE/health" >/dev/null 2>&1 && break; sleep 1; done
echo "server ready after $(( $(date +%s) - START ))s"
curl -sf -X POST "$BASE/assets" -H 'content-type: application/json' -d "{\"underlying\":\"$SYM\"}" >/dev/null
RES=$(curl -sf -X POST "$BASE/investment-assessment" -H 'content-type: application/json' -d "{\"asset_id\":\"tok-$(echo "$SYM" | tr A-Z a-z)\",\"wait\":true}")
echo "$RES" > "$DATA/r.json"
python3 - "$DATA/r.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); r=d["report"]
print("status      :", r["assessment"]["status"], "via", ", ".join(r["assessment"]["determining_rules"]))
print("scenarios   :", sum(1 for s in r["scenarios"] if s["status"]=="computed"), "computed")
print("peers       :", r["peers"]["comparability_note"][:90])
print("data quality:", r["market"]["snapshot"]["data_quality_status"], "| sources:", len(r["market"]["snapshot"]["sources"]))
print("calc hash   :", r["hashes"]["calculation_hash"])
PY
ID=$(python3 -c "import json;print(json.load(open('$DATA/r.json'))['analysis_id'])")
echo "reproduce   : $(curl -sf "$BASE/analyses/$ID/reproduce" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("identical hash" if d["reproduced"] else "MISMATCH")')"
EV=$(curl -sf "$BASE/demo/evidence-case")
python3 -c "import json,sys;print(json.dumps(json.loads(sys.argv[1])['dossier']))" "$EV" > "$DATA/ev.json"
curl -sf -X POST "$BASE/assets" -H 'content-type: application/json' -d @"$DATA/ev.json" >/dev/null
EVR=$(curl -sf -X POST "$BASE/investment-assessment" -H 'content-type: application/json' -d '{"asset_id":"'"$(python3 -c "import json;print(json.load(open('$DATA/ev.json')) and '')" )"'tok-nvda-'"$(python3 -c "import json;print(json.load(open('$DATA/ev.json'))['token']['contract_address'][2:8].lower())")"'","wait":true}')
echo "$EVR" > "$DATA/evr.json"
python3 - "$DATA/evr.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))["report"]
c=[x for x in r["evidence"]["conflicts"]]
print("evidence demo:", r["assessment"]["status"], "via", ", ".join(r["assessment"]["determining_rules"]))
for x in c: print("  conflict:", x["field"], " vs ".join(f'{v["source"]}={v["value"]}' for v in x["values"]), f'({x.get("max_difference_pct")}% apart)')
print("  injection findings (flagged, ignored):", len(r["evidence"]["injection_findings"]))
PY
echo "forced error: $(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/assets" -H 'content-type: application/json' -d '{"underlying":"DOGE"}') (expect 422, no fake success)"
echo "total elapsed $(( $(date +%s) - START ))s — open http://localhost:$PORT/app/ while this runs: press Ctrl-C to stop"
[ "${NO_WAIT:-0}" = 1 ] || sleep 600
