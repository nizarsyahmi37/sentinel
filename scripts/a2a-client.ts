/**
 * Minimal buyer-side client for the deployed Sentinel (BNB platform trial).
 *   1) OAuth2 client_credentials → access token (credentials in the form BODY, not Basic auth)
 *   2) A2A message/send `negotiate` → prints the signed quote (no payment happens)
 *   3) with JOB_ID set: A2A `notify_funded` for a job you already funded on-chain
 *
 * Credentials come from the environment and are never printed:
 *   SENTINEL_CLIENT_ID / SENTINEL_CLIENT_SECRET   (from `bag platform invoke-client new`)
 * Optional: AGENT_ID, PLATFORM, TASK, JOB_ID
 *
 *   pnpm --dir app/agent exec tsx ../../scripts/a2a-client.ts
 * Funding the job (createJob → registerJob → setBudget → fund) is done from a separate buyer wallet:
 * see scripts/hire-sentinel.sh.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
try {
  process.loadEnvFile(fileURLToPath(new URL("../.studio/.env.local", import.meta.url))); // same file `bag env set` writes
} catch {
  /* fall back to the shell environment */
}

const PLATFORM = process.env.PLATFORM ?? "https://bnbagent-api.bnbchain.world";
const AGENT_ID = process.env.AGENT_ID ?? "01M53XVV1VPE9MS604Y48VB4PM";
// the buyer SDK requires the payment token inside the signed request terms (testnet U, ERC-8183)
const CURRENCY = process.env.CURRENCY ?? "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565";
const TASK = process.env.TASK ?? "equity:NVDA";
const id = process.env.SENTINEL_CLIENT_ID;
const secret = process.env.SENTINEL_CLIENT_SECRET;
if (!id || !secret) {
  console.error("Set SENTINEL_CLIENT_ID and SENTINEL_CLIENT_SECRET (run `bag platform invoke-client new`).");
  process.exit(2);
}

async function token(): Promise<string> {
  const res = await fetch(`${PLATFORM}/v1/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: id!,
      client_secret: secret!,
      scope: `invoke:${AGENT_ID}`,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!res.ok || !body.access_token) throw new Error(`token request failed: HTTP ${res.status} ${body.error ?? ""}`);
  return body.access_token;
}

async function send(bearer: string, data: Record<string, unknown>, rid: string): Promise<unknown> {
  const url = new URL(`${PLATFORM}/v1/rt/${AGENT_ID}/a2a`);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: rid,
      method: "message/send",
      params: { message: { messageId: `msg-${rid}`, role: "user", parts: [{ kind: "data", data }] } },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  console.log(`HTTP ${res.status}`);
  try {
    const parsed = JSON.parse(text);
    console.log(JSON.stringify(parsed, null, 2));
    return parsed;
  } catch {
    console.log(text.slice(0, 2000));
    return undefined;
  }
}

async function main() {
  const bearer = await token();
  console.log("token ok");
  console.log("\n--- negotiate ---");
  const quote = (await send(bearer, { skill: "negotiate", task_description: TASK, terms: { deliverables: "Sentinel report", quality_standards: "evidence-backed, reproducible", currency: CURRENCY } }, "request-1")) as { result?: { parts?: { data?: unknown }[] } } | undefined;
  const envelope = quote?.result?.parts?.[0]?.data;
  if (process.env.QUOTE_OUT && envelope) {
    writeFileSync(process.env.QUOTE_OUT, JSON.stringify(envelope)); // the signed quote only; no credentials
    console.log(`signed quote saved to ${process.env.QUOTE_OUT}`);
  }
  if (process.env.JOB_ID) {
    console.log("\n--- notify_funded ---");
    await send(bearer, { skill: "notify_funded", job_id: Number(process.env.JOB_ID) }, "request-2");
  }
}
main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
});
