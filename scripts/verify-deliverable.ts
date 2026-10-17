/**
 * Verify a Sentinel deliverable: recompute the report hash from the report
 * body and check it matches the hash the seller declared.
 *   cd app/agent && npx tsx ../../scripts/verify-deliverable.ts deliverable.json
 * A matching hash shows the report was not altered; it does NOT show the
 * underlying facts are correct.
 */
import { readFileSync } from "node:fs";
import { hashOf } from "../app/agent/src/sentinel/util.js";

const file = process.argv[2];
if (!file) {
  console.error("usage: verify-deliverable.ts <deliverable.json>");
  process.exit(2);
}
const raw = JSON.parse(readFileSync(file, "utf8"));
// `bag erc8183 fetch` returns a manifest {response:{content}}; accept both shapes.
const payload = typeof raw?.response?.content === "string" ? JSON.parse(raw.response.content) : raw;
const { report, sentinel } = payload;
const { hashes, ...rest } = report;
const recomputed = hashOf({ ...rest, hashes: undefined });
const ok = recomputed === hashes.report_hash && sentinel.report_hash === hashes.report_hash;
console.log(JSON.stringify({ status: report.assessment.status, declared: hashes.report_hash, recomputed, calculation_hash: hashes.calculation_hash, ok }, null, 2));
process.exit(ok ? 0 : 1);
